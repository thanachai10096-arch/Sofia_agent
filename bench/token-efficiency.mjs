import assert from "node:assert/strict";
import { TokenAwareGateway } from "../src/brain/token-aware-gateway.ts";
import { TokenBudget } from "../src/brain/token-budget.ts";

function estimate(core, evidence) {
  const chars = core.instructions + core.task + core.acceptanceCriteria.join("\n") +
    JSON.stringify(core.state) + JSON.stringify(core.toolSchemas) +
    evidence.map((item) => item.text).join("\n");
  return Math.ceil(chars.length / 4);
}

const core = {
  instructions: "Follow the task, preserve safety rules, and cite relevant evidence. ".repeat(8),
  task: "Summarize the most relevant evidence while keeping important facts.",
  acceptanceCriteria: ["Preserve high-relevance evidence", "Stay within input token budget"],
  state: { phase: "benchmark", status: "ready" },
  toolSchemas: [{ name: "read_file", description: "Read a workspace file safely" }],
};

const evidence = Array.from({ length: 64 }, (_, index) => ({
  id: "evidence-" + index,
  relevance: index < 4 ? 1 : Math.max(0.1, 0.95 - index * 0.012),
  text: "Evidence " + index + ": " + ("context detail item-" + index + " ").repeat(22),
}));
for (let index = 0; index < 16; index++) {
  evidence.push({
    id: "duplicate-" + index,
    relevance: evidence[index].relevance,
    text: evidence[index].text,
  });
}

const baselineTokens = estimate(core, evidence);
let selectedEvidence = [];
const budget = new TokenBudget(
  { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 4, maxInFlight: 1 },
  [{
    key: "fixture",
    limit: { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 4, maxInFlight: 1 },
    price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 1n },
  }],
);
const route = {
  id: "offline-fixture",
  budgetKey: "fixture",
  qualityTier: 1,
  capabilities: [],
  contextWindow: 5_300,
  maxOutputTokens: 300,
  hardOutputCap: true,
  prepare(prompt) {
    const inputTokensUpperBound = estimate(prompt.core, prompt.evidence);
    return {
      inputTokensUpperBound,
      async invoke() {
        selectedEvidence = prompt.evidence;
        return {
          value: { accepted: true },
          usage: { inputTokens: inputTokensUpperBound, outputTokens: 20 },
          finishReason: "complete",
        };
      },
    };
  },
};
const gateway = new TokenAwareGateway(budget, [route], 5_000);
const result = await gateway.generateMetered({
  phase: "understand",
  minimumQualityTier: 1,
  requiredCapabilities: [],
  core,
  evidence,
});
const actualTokens = result.usage.inputTokens;
const savingsRatio = baselineTokens === 0 ? 0 : 1 - actualTokens / baselineTokens;
const selectedIds = new Set(selectedEvidence.map((item) => item.id));
assert.equal(result.value && result.value.accepted, true);
assert.ok(selectedEvidence.length < evidence.length, "packer should drop duplicates and over-budget evidence");
assert.ok(["evidence-0", "evidence-1", "evidence-2", "evidence-3"].every((id) => selectedIds.has(id)),
  "all highest-relevance fixture chunks must survive packing");
assert.equal(new Set(selectedEvidence.map((item) => item.text)).size, selectedEvidence.length,
  "packed evidence must not contain duplicate text");
assert.ok(savingsRatio > 0.1, "fixture should demonstrate at least 10% estimated input-token reduction");

console.log(JSON.stringify({
  benchmark: "offline-evidence-packing",
  baselineEstimatedInputTokens: baselineTokens,
  packedEstimatedInputTokens: actualTokens,
  estimatedInputTokenReductionPercent: Number((savingsRatio * 100).toFixed(2)),
  suppliedEvidenceChunks: evidence.length,
  packedEvidenceChunks: selectedEvidence.length,
  highRelevanceEvidencePreserved: true,
  providerCalls: 0,
  caveat: "Synthetic tokenizer fixture only; not a live-provider or end-to-end task-savings claim.",
}, null, 2));
