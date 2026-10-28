import assert from "node:assert/strict";
import test from "node:test";

import { TokenAwareGateway } from "./token-aware-gateway.js";
import { TokenBudget } from "./token-budget.js";
import { TokenAwareBrainReasoner } from "./token-aware-reasoner.js";

test("token-aware Brain reasoner passes project memory and execution evidence through the packer", async () => {
  let packedEvidence: readonly { id: string; text: string; relevance: number }[] = [];
  const budget = new TokenBudget(
    { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 4, maxInFlight: 1 },
    [{
      key: "test",
      limit: { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 4, maxInFlight: 1 },
      price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 1n },
    }],
  );
  const route = {
    id: "reasoner-test",
    budgetKey: "test",
    qualityTier: 1,
    capabilities: [],
    contextWindow: 8_000,
    maxOutputTokens: 512,
    hardOutputCap: true,
    prepare(prompt: { evidence: readonly { id: string; text: string; relevance: number }[]; core: { instructions: string; task: string; acceptanceCriteria: readonly string[]; state: unknown; toolSchemas: readonly unknown[] } }) {
      const encoded = JSON.stringify({ core: prompt.core, evidence: prompt.evidence });
      return {
        inputTokensUpperBound: Math.ceil(encoded.length / 4),
        async invoke() {
          packedEvidence = prompt.evidence;
          return {
            value: { ok: true },
            usage: { inputTokens: Math.ceil(encoded.length / 4), outputTokens: 5 },
            finishReason: "complete" as const,
          };
        },
      };
    },
  };
  const reasoner = new TokenAwareBrainReasoner(new TokenAwareGateway(budget, [route], 5_000));
  const prepared = await reasoner.prepare(JSON.stringify({
    phase: "plan",
    payload: {
      task: "Update the token efficiency benchmark",
      understanding: { successCriteria: ["preserve relevant evidence"] },
    },
    memory: {
      observations: [{ tool: "workspace.read_file", preview: "benchmark runner reports input tokens" }],
      diagnoses: [{ category: "incomplete_solution", message: "the task missed provider usage" }],
      decisions: [{ strategy: "inspect-evidence", reason: "check the benchmark fixture" }],
      projectContext: "Project instructions: preserve existing public interfaces.",
      projectMemory: [{ kind: "convention", content: "Use node:test for regression tests", confidence: 0.9 }],
    },
  }), { signal: new AbortController().signal, maxContextTokens: 8_000 });

  const result = await prepared.invoke({ signal: new AbortController().signal, maxOutputTokens: 512 });
  assert.deepEqual(result.value, { ok: true });
  assert.ok(packedEvidence.length >= 5);
  assert.ok(packedEvidence.some((item) => item.text.includes("benchmark runner reports input tokens")));
  assert.ok(packedEvidence.some((item) => item.text.includes("preserve existing public interfaces")));
  assert.ok(packedEvidence.some((item) => item.text.includes("Use node:test for regression tests")));
  assert.ok(packedEvidence.every((item) => item.text.includes("untrusted reference data")));
  assert.equal(new Set(packedEvidence.map((item) => item.id)).size, packedEvidence.length);
});

test("token-aware Brain reasoner preserves legacy requests with no memory", async () => {
  const budget = new TokenBudget(
    { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 4, maxInFlight: 1 },
    [{
      key: "test",
      limit: { maxTokens: 20_000, maxCostNanoUsd: 100_000_000n, maxCalls: 4, maxInFlight: 1 },
      price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 1n },
    }],
  );
  const route = {
    id: "legacy-test",
    budgetKey: "test",
    qualityTier: 1,
    capabilities: [],
    contextWindow: 8_000,
    maxOutputTokens: 512,
    hardOutputCap: true,
    prepare(prompt: { evidence: readonly unknown[] }) {
      const count = prompt.evidence.length;
      return {
        inputTokensUpperBound: 10 + count,
        async invoke() {
          return { value: { evidenceCount: count }, usage: { inputTokens: 10 + count, outputTokens: 1 }, finishReason: "complete" as const };
        },
      };
    },
  };
  const reasoner = new TokenAwareBrainReasoner(new TokenAwareGateway(budget, [route], 5_000));
  const prepared = await reasoner.prepare(JSON.stringify({ phase: "understand", payload: { task: "legacy request" } }), {
    signal: new AbortController().signal,
    maxContextTokens: 8_000,
  });
  const result = await prepared.invoke({ signal: new AbortController().signal, maxOutputTokens: 512 });
  assert.deepEqual(result.value, { evidenceCount: 0 });
});
