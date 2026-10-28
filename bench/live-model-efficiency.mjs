import assert from "node:assert/strict";

const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.Gemini_API_Key?.trim();
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY. This benchmark is opt-in and makes live provider calls.");
  process.exit(2);
}
const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
const baseUrl = (process.env.GEMINI_OPENAI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/").replace(/\/$/, "");
const timeoutMs = Number(process.env.SOFIA_LIVE_BENCHMARK_TIMEOUT_MS || 45000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) {
  throw new Error("SOFIA_LIVE_BENCHMARK_TIMEOUT_MS must be an integer from 1000 to 180000");
}

// Small, deterministic extraction fixtures. Each task is run once with the full
// evidence set and once with only the relevant evidence. No provider fallback.
const tasks = [
  {
    id: "project-code",
    question: "What is the project code? Reply with only the code.",
    expected: "SOFIA-731",
    relevant: "Project code: SOFIA-731.",
    noise: "The office plant is named Fern. The team meets on Thursday. The sample build is green.",
  },
  {
    id: "release-date",
    question: "What is the release date? Reply with only the date.",
    expected: "2026-11-12",
    relevant: "Release date: 2026-11-12.",
    noise: "The project uses TypeScript. The support window is 09:00-17:00. The icon is blue.",
  },
  {
    id: "retry-limit",
    question: "What is the retry limit? Reply with only the integer.",
    expected: "3",
    relevant: "Retry limit: 3 attempts.",
    noise: "The cache expires after 15 minutes. The branch is called feature/cleanup. The app supports dark mode.",
  },
];

async function callModel(task, evidence, variant) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "authorization": "Bearer " + apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 128,
        messages: [
          { role: "system", content: "Answer only from the supplied evidence. If the answer is absent, say UNKNOWN. Follow the requested output format." },
          { role: "user", content: task.question + "\n\nEvidence:\n" + evidence },
        ],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Do not print response bodies: providers can include request metadata.
      throw new Error("Provider request failed with HTTP " + response.status);
    }
    const answer = payload?.choices?.[0]?.message?.content;
    if (typeof answer !== "string") throw new Error("Provider returned no text answer");
    const usage = payload?.usage;
    const inputTokens = Number.isSafeInteger(usage?.prompt_tokens) ? usage.prompt_tokens : null;
    const outputTokens = Number.isSafeInteger(usage?.completion_tokens) ? usage.completion_tokens : null;
    return {
      taskId: task.id,
      variant,
      model,
      answer: answer.trim(),
      verified: answer.trim().includes(task.expected),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
      durationMs: Math.round(performance.now() - started),
      usageReported: inputTokens !== null && outputTokens !== null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const results = [];
for (const task of tasks) {
  const fullEvidence = task.relevant + "\n" + task.noise.repeat(8);
  results.push(await callModel(task, fullEvidence, "baseline-full-evidence"));
  results.push(await callModel(task, task.relevant, "compact-relevant-evidence"));
}

const baseline = results.filter((r) => r.variant === "baseline-full-evidence");
const compact = results.filter((r) => r.variant === "compact-relevant-evidence");
const sum = (rows, field) => rows.every((r) => Number.isSafeInteger(r[field]))
  ? rows.reduce((total, r) => total + r[field], 0)
  : null;
const baselineTokens = sum(baseline, "totalTokens");
const compactTokens = sum(compact, "totalTokens");
const reductionPercent = baselineTokens && compactTokens !== null
  ? Number(((1 - compactTokens / baselineTokens) * 100).toFixed(2))
  : null;
const summary = {
  benchmark: "live-model-context-efficiency",
  model,
  taskCount: tasks.length,
  providerCalls: results.length,
  baseline: {
    verifiedTasks: baseline.filter((r) => r.verified).length,
    inputTokens: sum(baseline, "inputTokens"),
    outputTokens: sum(baseline, "outputTokens"),
    totalTokens: baselineTokens,
    durationMs: sum(baseline, "durationMs"),
  },
  compact: {
    verifiedTasks: compact.filter((r) => r.verified).length,
    inputTokens: sum(compact, "inputTokens"),
    outputTokens: sum(compact, "outputTokens"),
    totalTokens: compactTokens,
    durationMs: sum(compact, "durationMs"),
  },
  totalTokenReductionPercent: reductionPercent,
  actualCost: null,
  actualCostNote: "Cost is not inferred. Provider pricing and invoice-level billing are not queried.",
  usageComplete: results.every((r) => r.usageReported),
  results,
  caveat: "Live provider calls on three small extraction fixtures. This compares full vs manually compacted evidence, not the full Sofia agent task loop and not the TokenAwareGateway packer itself. Results are not generalizable quality or savings claims.",
};
console.log(JSON.stringify(summary, null, 2));
assert.equal(results.length, tasks.length * 2);
if (!summary.usageComplete) process.exitCode = 3;
