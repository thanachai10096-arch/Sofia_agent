import assert from "node:assert/strict";

// Provider-agnostic harness for OpenAI-compatible chat-completions endpoints.
// No provider/model defaults and no automatic provider fallback.
const apiKey = process.env.SOFIA_BENCH_API_KEY?.trim();
const model = process.env.SOFIA_BENCH_MODEL?.trim();
const configuredBaseUrl = process.env.SOFIA_BENCH_API_BASE_URL?.trim();
if (!apiKey || !model || !configuredBaseUrl) {
  console.error("Set SOFIA_BENCH_API_BASE_URL, SOFIA_BENCH_API_KEY, and SOFIA_BENCH_MODEL. This opt-in benchmark makes live provider calls.");
  process.exit(2);
}
let parsedBaseUrl;
try {
  parsedBaseUrl = new URL(configuredBaseUrl);
} catch {
  throw new Error("SOFIA_BENCH_API_BASE_URL must be a valid absolute URL");
}
if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.hostname !== "localhost" && parsedBaseUrl.hostname !== "127.0.0.1") {
  throw new Error("SOFIA_BENCH_API_BASE_URL must use HTTPS (HTTP is allowed only for localhost)");
}
const baseUrl = configuredBaseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
const timeoutMs = Number(process.env.SOFIA_LIVE_BENCHMARK_TIMEOUT_MS || 45000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) {
  throw new Error("SOFIA_LIVE_BENCHMARK_TIMEOUT_MS must be an integer from 1000 to 180000");
}
// Optional explicit list pricing (USD per one million tokens). These are estimates,
// not invoice data; never infer pricing from model names or provider defaults.
function readPrice(name) {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(raw)) {
    throw new Error(name + " must be a non-negative decimal USD price per million tokens");
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(name + " is not a finite number");
  return value;
}
const inputPricePerMillionUsd = readPrice("SOFIA_BENCH_INPUT_USD_PER_MILLION_TOKENS");
const outputPricePerMillionUsd = readPrice("SOFIA_BENCH_OUTPUT_USD_PER_MILLION_TOKENS");
if ((inputPricePerMillionUsd === null) !== (outputPricePerMillionUsd === null)) {
  throw new Error("Set both SOFIA_BENCH_INPUT_USD_PER_MILLION_TOKENS and SOFIA_BENCH_OUTPUT_USD_PER_MILLION_TOKENS, or neither");
}

// Small, deterministic synthetic extraction fixtures; never user content.
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
        authorization: "Bearer " + apiKey,
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
    const rawInputTokens = usage?.prompt_tokens ?? usage?.input_tokens;
    const rawOutputTokens = usage?.completion_tokens ?? usage?.output_tokens;
    const inputTokens = Number.isSafeInteger(rawInputTokens) ? rawInputTokens : null;
    const outputTokens = Number.isSafeInteger(rawOutputTokens) ? rawOutputTokens : null;
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
function estimatedCostUsd(rows) {
  if (inputPricePerMillionUsd === null || outputPricePerMillionUsd === null ||
      !rows.every((r) => r.usageReported)) return null;
  return Number(rows.reduce((total, row) =>
    total + row.inputTokens * inputPricePerMillionUsd / 1_000_000
      + row.outputTokens * outputPricePerMillionUsd / 1_000_000, 0).toFixed(10));
}
const baselineVerified = baseline.filter((r) => r.verified).length;
const compactVerified = compact.filter((r) => r.verified).length;
const baselineEstimatedCostUsd = estimatedCostUsd(baseline);
const compactEstimatedCostUsd = estimatedCostUsd(compact);
const summary = {
  benchmark: "live-model-context-efficiency",
  endpointType: "OpenAI-compatible chat completions",
  model,
  taskCount: tasks.length,
  providerCalls: results.length,
  baseline: {
    verifiedTasks: baselineVerified,
    estimatedCostUsd: baselineEstimatedCostUsd,
    estimatedCostPerVerifiedSuccessUsd: baselineVerified > 0 && baselineEstimatedCostUsd !== null
      ? Number((baselineEstimatedCostUsd / baselineVerified).toFixed(10)) : null,
    inputTokens: sum(baseline, "inputTokens"),
    outputTokens: sum(baseline, "outputTokens"),
    totalTokens: baselineTokens,
    durationMs: sum(baseline, "durationMs"),
  },
  compact: {
    verifiedTasks: compactVerified,
    estimatedCostUsd: compactEstimatedCostUsd,
    estimatedCostPerVerifiedSuccessUsd: compactVerified > 0 && compactEstimatedCostUsd !== null
      ? Number((compactEstimatedCostUsd / compactVerified).toFixed(10)) : null,
    inputTokens: sum(compact, "inputTokens"),
    outputTokens: sum(compact, "outputTokens"),
    totalTokens: compactTokens,
    durationMs: sum(compact, "durationMs"),
  },
  totalTokenReductionPercent: reductionPercent,
  actualCost: null,
  actualCostNote: "Invoice-level actual cost is not queried. Estimated cost is emitted only when explicit input/output prices are configured.",
  configuredPricingUsdPerMillionTokens: inputPricePerMillionUsd === null ? null : {
    input: inputPricePerMillionUsd,
    output: outputPricePerMillionUsd,
  },
  usageComplete: results.every((r) => r.usageReported),
  results,
  caveat: "Live provider calls on three small synthetic extraction fixtures. This compares full vs manually compacted evidence, not the full Sofia agent task loop and not the TokenAwareGateway packer itself. Results are not generalizable quality or savings claims.",
};
console.log(JSON.stringify(summary, null, 2));
assert.equal(results.length, tasks.length * 2);
if (!summary.usageComplete) process.exitCode = 3;
