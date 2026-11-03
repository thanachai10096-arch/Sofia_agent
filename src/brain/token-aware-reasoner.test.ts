import assert from "node:assert/strict";
import test from "node:test";
import { TokenAwareBrainReasoner } from "./token-aware-reasoner.js";
import type { TokenAwareGateway, InferenceRequest } from "./token-aware-gateway.js";

async function promptFor(phase: string): Promise<string> {
  let captured: InferenceRequest | undefined;
  const gateway = {
    async generateMetered(input: InferenceRequest) {
      captured = input;
      return { value: {}, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as TokenAwareGateway;
  const reasoner = new TokenAwareBrainReasoner(gateway);
  const controller = new AbortController();
  const prepared = await reasoner.prepare(JSON.stringify({ phase, payload: { task: "Test task" } }), {
    signal: controller.signal, maxContextTokens: 1000,
  });
  await prepared.invoke({ signal: controller.signal, maxOutputTokens: 100 });
  assert.ok(captured);
  return captured.core.instructions;
}

test("understanding prompt contains the exact parsed fields and risk enum", async () => {
  const prompt = await promptFor("understand");
  for (const field of ["objective", "constraints", "assumptions", "requiredCapabilities", "requiredTools", "risk", "successCriteria", "ambiguities"]) {
    assert.match(prompt, new RegExp(`"${field}"`));
  }
  assert.match(prompt, /low\|medium\|high/);
});

test("plan and replan prompts contain the ExecutionPlan parser contract", async () => {
  for (const phase of ["plan", "replan"]) {
    const prompt = await promptFor(phase);
    for (const field of ["strategy", "reason", "steps", "id", "objective", "dependencies", "call", "tool", "input"]) {
      assert.match(prompt, new RegExp(`"${field}"`));
    }
    assert.match(prompt, /inspect-evidence/);
    assert.match(prompt, /fix-implementation/);
  }
});
