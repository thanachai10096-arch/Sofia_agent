import { TokenAwareGateway } from "../src/brain/token-aware-gateway.ts";
import { TokenBudget } from "../src/brain/token-budget.ts";

export function estimatePromptTokens(core, evidence) {
  const chars = core.instructions + core.task + core.acceptanceCriteria.join("\n") +
    JSON.stringify(core.state) + JSON.stringify(core.toolSchemas) +
    evidence.map((item) => item.text).join("\n");
  return Math.ceil(chars.length / 4);
}

/** Exercise Sofia's actual evidence packer with a synthetic route; never calls a provider. */
export async function packWithSofiaGateway(task) {
  const core = {
    instructions: "Answer only from supplied evidence. Preserve relevant facts and do not invent details.",
    task: task.question,
    acceptanceCriteria: ["Keep the fact needed to answer the question"],
    state: { phase: "benchmark", status: "ready" },
    toolSchemas: [],
  };
  const evidence = [{ id: task.id + "-relevant", relevance: 1, text: task.relevant }];
  for (let index = 0; index < 64; index++) {
    evidence.push({
      id: task.id + "-noise-" + index,
      relevance: 0.15 + ((index % 5) * 0.01),
      text: "Unrelated synthetic note " + index + ": " + task.noise.repeat(5),
    });
  }
  let selectedEvidence = [];
  const budget = new TokenBudget(
    { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 4, maxInFlight: 1 },
    [{ key: "benchmark-fixture", limit: { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 4, maxInFlight: 1 }, price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 1n } }],
  );
  const route = {
    id: "benchmark-offline-packer",
    budgetKey: "benchmark-fixture",
    qualityTier: 1,
    capabilities: [],
    contextWindow: 5_300,
    maxOutputTokens: 300,
    hardOutputCap: true,
    prepare(prompt) {
      const inputTokensUpperBound = estimatePromptTokens(prompt.core, prompt.evidence);
      return {
        inputTokensUpperBound,
        async invoke() {
          selectedEvidence = [...prompt.evidence];
          return {
            value: { packed: true },
            usage: { inputTokens: inputTokensUpperBound, outputTokens: 1 },
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
  if (!selectedEvidence.some((item) => item.id === task.id + "-relevant")) {
    throw new Error("Sofia TokenAwareGateway discarded the high-relevance benchmark fact");
  }
  return {
    selectedEvidence,
    packedText: selectedEvidence.map((item) => item.text).join("\n"),
    inputTokensUpperBound: result.usage.inputTokens,
    suppliedEvidenceCount: evidence.length,
  };
}
