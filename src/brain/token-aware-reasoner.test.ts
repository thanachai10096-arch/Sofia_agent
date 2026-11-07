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

test("subagent prompt contains the explicit untrusted proposal shape", async () => {
  const prompt = await promptFor("subagent");
  for (const field of ["tool", "input", "reason"]) {
    assert.match(prompt, new RegExp(`"${field}"`));
  }
  assert.match(prompt, /untrusted proposal/);
  assert.match(prompt, /parent Brain must validate permissions/);
});


test("normalized prompt keeps task once and moves memory into bounded state", async () => {
  let captured: InferenceRequest | undefined;
  const gateway = {
    async generateMetered(input: InferenceRequest) {
      captured = input;
      return { value: {}, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as TokenAwareGateway;
  const reasoner = new TokenAwareBrainReasoner(gateway);
  const controller = new AbortController();
  const request = JSON.stringify({
    phase: "plan",
    payload: {
      task: "Build a safe feature",
      understanding: { successCriteria: ["criterion one"], requiredCapabilities: ["coding"] },
      availableTools: [{ name: "read_file" }],
    },
    memory: {
      observations: [{ summary: "prior observation" }],
      projectMemory: [{ content: "project convention" }],
    },
  });
  const prepared = await reasoner.prepare(request, { signal: controller.signal, maxContextTokens: 16_000 });
  assert.ok(prepared.inputTokens > 1);
  await prepared.invoke({ signal: controller.signal, maxOutputTokens: 100 });
  assert.ok(captured);
  assert.equal(captured.core.task, "Build a safe feature");
  assert.equal(JSON.stringify(captured.core.state).includes("Build a safe feature"), false);
  assert.equal(JSON.stringify(captured.core.state).includes("prior observation"), true);
  assert.equal(JSON.stringify(captured.core.state).includes("project convention"), true);
  assert.deepEqual(captured.core.acceptanceCriteria, ["criterion one"]);
  assert.deepEqual(captured.requiredCapabilities, ["reasoning", "coding"]);
});

test("normalized prompt bounds oversized memory without truncating the task", async () => {
  let captured: InferenceRequest | undefined;
  const gateway = {
    async generateMetered(input: InferenceRequest) {
      captured = input;
      return { value: {}, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as TokenAwareGateway;
  const reasoner = new TokenAwareBrainReasoner(gateway);
  const controller = new AbortController();
  const task = "ตอบคำถามนี้ให้สำเร็จ";
  const hugeMemory = "x".repeat(50_000);
  const prepared = await reasoner.prepare(JSON.stringify({
    phase: "understand",
    payload: { task },
    memory: { observations: [{ content: hugeMemory }] },
  }), { signal: controller.signal, maxContextTokens: 16_000 });
  await prepared.invoke({ signal: controller.signal, maxOutputTokens: 100 });
  assert.ok(captured);
  assert.equal(captured.core.task, task);
  assert.ok(JSON.stringify(captured.core.state).length < 20_000);
});


test("ordinary conversation task labels do not reject every model route", async () => {
  let captured: InferenceRequest | undefined;
  const gateway = {
    async generateMetered(input: InferenceRequest) {
      captured = input;
      return { value: {}, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as TokenAwareGateway;
  const reasoner = new TokenAwareBrainReasoner(gateway);
  const controller = new AbortController();
  const prepared = await reasoner.prepare(JSON.stringify({
    phase: "understand",
    payload: { task: "ตอบว่า 2+2 เท่ากับเท่าไร", requiredCapabilities: ["general"] },
  }), { signal: controller.signal, maxContextTokens: 16_000 });
  await prepared.invoke({ signal: controller.signal, maxOutputTokens: 100 });
  assert.deepEqual(captured?.requiredCapabilities, ["reasoning"]);
});

test("task intent labels map to supported provider capabilities", async () => {
  let captured: InferenceRequest | undefined;
  const gateway = {
    async generateMetered(input: InferenceRequest) {
      captured = input;
      return { value: {}, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as TokenAwareGateway;
  const reasoner = new TokenAwareBrainReasoner(gateway);
  const controller = new AbortController();
  const prepared = await reasoner.prepare(JSON.stringify({
    phase: "understand",
    payload: { task: "Analyze a code issue", understanding: { requiredCapabilities: ["analysis", "code", "general"] } },
  }), { signal: controller.signal, maxContextTokens: 16_000 });
  await prepared.invoke({ signal: controller.signal, maxOutputTokens: 100 });
  assert.deepEqual(captured?.requiredCapabilities, ["reasoning", "coding"]);
});


test("understand phase requires reasoning and cannot be routed to fast-only models", async () => {
  let captured: InferenceRequest | undefined;
  const gateway = {
    async generateMetered(input: InferenceRequest) {
      captured = input;
      return { value: {}, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as TokenAwareGateway;
  const reasoner = new TokenAwareBrainReasoner(gateway);
  const controller = new AbortController();
  const prepared = await reasoner.prepare(JSON.stringify({
    phase: "understand",
    payload: { task: "เขียนโค้ดสร้างแกนเป็นเดือนแกนพร้อมรับใช้มนุษย์โลก" },
  }), { signal: controller.signal, maxContextTokens: 16_000 });
  await prepared.invoke({ signal: controller.signal, maxOutputTokens: 700 });
  assert.deepEqual(captured?.requiredCapabilities, ["reasoning"]);
});

test("implementation and response phases request their matching route capabilities", async () => {
  for (const [phase, expected] of [["implement", ["coding"]], ["respond", ["fast"]]] as const) {
    let captured: InferenceRequest | undefined;
    const gateway = {
      async generateMetered(input: InferenceRequest) {
        captured = input;
        return { value: {}, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } as unknown as TokenAwareGateway;
    const reasoner = new TokenAwareBrainReasoner(gateway);
    const controller = new AbortController();
    const prepared = await reasoner.prepare(JSON.stringify({
      phase,
      payload: { task: "Test task" },
    }), { signal: controller.signal, maxContextTokens: 16_000 });
    await prepared.invoke({ signal: controller.signal, maxOutputTokens: 700 });
    assert.deepEqual(captured?.requiredCapabilities, expected);
  }
});
