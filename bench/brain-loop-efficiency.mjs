import { createSofiaBrain } from "../src/brain/executor.ts";
import { TokenAwareGateway } from "../src/brain/token-aware-gateway.ts";
import { TokenBudget } from "../src/brain/token-budget.ts";
import { TokenAwareBrainReasoner } from "../src/brain/token-aware-reasoner.ts";

const usageByPhase = [];
const budget = new TokenBudget(
  { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 12, maxInFlight: 1 },
  [{ key: "offline-brain-loop", limit: { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 12, maxInFlight: 1 }, price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 1n } }],
);

function estimateTokens(prompt) {
  return Math.ceil(JSON.stringify({ core: prompt.core, evidence: prompt.evidence }).length / 4);
}

const route = {
  id: "offline-brain-loop-route",
  budgetKey: "offline-brain-loop",
  qualityTier: 1,
  capabilities: ["structured-output"],
  contextWindow: 8_000,
  maxOutputTokens: 512,
  hardOutputCap: true,
  prepare(prompt) {
    const inputTokensUpperBound = estimateTokens(prompt);
    const phase = prompt.core.state?.phase;
    const value = phase === "understand"
      ? {
          objective: "Create hello.txt",
          constraints: [],
          assumptions: [],
          requiredCapabilities: ["file-write"],
          requiredTools: ["workspace.write_file"],
          risk: "low",
          successCriteria: ["hello.txt exists"],
          ambiguities: [],
        }
      : {
          strategy: "initial",
          reason: "Create the requested file and verify it.",
          steps: [{
            id: "write",
            objective: "Write hello.txt",
            dependencies: [],
            call: { tool: "workspace.write_file", input: { path: "hello.txt", content: "hello" } },
          }],
        };
    return {
      inputTokensUpperBound,
      async invoke() {
        usageByPhase.push({ phase, inputTokensUpperBound, evidenceCount: prompt.evidence.length });
        return {
          value,
          usage: { inputTokens: inputTokensUpperBound, outputTokens: 20 },
          finishReason: "complete",
        };
      },
    };
  },
};

const reasoner = new TokenAwareBrainReasoner(new TokenAwareGateway(budget, [route], 7_500));
let measurement;
let revision = 0;
const tools = {
  describe(name) {
    if (name === "workspace.write_file") return { effects: ["write"] };
    if (name === "workspace.list_files") return { effects: ["read"] };
    return undefined;
  },
  async execute(call) {
    revision++;
    return {
      ok: true,
      data: call.tool === "workspace.list_files" ? ["hello.txt"] : { written: true },
      evidenceId: "offline-evidence-" + revision,
    };
  },
  async snapshot() { return { id: "snapshot-" + revision, revision: String(revision), evidenceId: "snapshot-evidence-" + revision }; },
  async changedFiles() { return ["hello.txt"]; },
  async checkpoint() { return { id: "checkpoint-1", revision: "0" }; },
  async rollback() { return []; },
};

const brain = createSofiaBrain({
  dependencies: {
    reasoner,
    tools,
    allowShell: false,
    allowNetwork: false,
    onEfficiencyMeasurement(value) { measurement = value; },
  },
  limits: {
    maxSteps: 4,
    maxToolCalls: 10,
    maxReplans: 1,
    maxModelCalls: 4,
    maxTokens: 20_000,
    maxContextTokens: 8_000,
    maxOutputTokens: 512,
    timeoutMs: 5_000,
  },
});

const report = await brain.run({
  task: "Create hello.txt and verify that it exists.",
  context: [
    "Relevant project note: hello.txt must contain the word hello.",
    ...Array.from({ length: 48 }, (_, i) => "Unrelated synthetic context " + i + ": " + "sample context ".repeat(12)),
  ].join("\n"),
  acceptanceCriteria: [{
    id: "file-exists",
    description: "hello.txt exists",
    probe: { tool: "workspace.list_files", input: { path: "." } },
    evaluate(data) {
      return { passed: Array.isArray(data) && data.includes("hello.txt"), detail: "hello.txt exists" };
    },
  }],
});

const output = {
  benchmark: "offline-sofia-brain-loop",
  mode: "deterministic synthetic model route; no network or provider calls",
  completed: report.completed,
  state: report.state,
  verifiedCriteria: report.verification.filter((item) => item.passed).length,
  acceptanceCriteria: report.verification.length,
  runtimeUsage: report.usage,
  efficiency: measurement ? {
    completed: measurement.completed,
    acceptanceCriteria: measurement.acceptanceCriteria,
    passedCriteria: measurement.passedCriteria,
    inputTokens: measurement.inputTokens,
    outputTokens: measurement.outputTokens,
    modelCalls: measurement.modelCalls,
    unmeasuredModelCalls: measurement.unmeasuredModelCalls,
    usageComplete: measurement.usageComplete,
    retries: measurement.retries,
    durationMs: measurement.durationMs,
  } : null,
  gatewayCalls: usageByPhase,
  caveat: "Synthetic token estimates and deterministic responses validate Brain-to-gateway wiring only; they are not provider-billed usage or real-world savings.",
};
console.log(JSON.stringify(output, null, 2));
if (!report.completed || !measurement || !measurement.usageComplete || measurement.passedCriteria !== measurement.acceptanceCriteria) {
  process.exitCode = 1;
}
