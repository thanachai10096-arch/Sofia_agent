import test from "node:test";
import assert from "node:assert/strict";
import { AdvancedSkillPolicyError, AdvancedSkillRegistry } from "./advanced-skill-runtime.js";
import type { AdvancedSkillDefinition } from "./advanced-skill-catalog.js";

function definition(overrides: Partial<AdvancedSkillDefinition> = {}): AdvancedSkillDefinition {
  return {
    id: "test.skill", name: "Test Skill", category: "Testing", risk: "read-only",
    status: "verified", requiresApproval: false, description: "test handler", ...overrides,
  };
}
function context(approved = false, signal = new AbortController().signal, trace: string[] = []) {
  return { principalId: "test-user", approved, signal, emitTrace: (event: { type: string }) => trace.push(event.type) };
}

test("registry refuses planned skills", () => {
  const registry = new AdvancedSkillRegistry();
  assert.throws(() => registry.register(definition({ status: "planned" }), () => "nope"),
    (error: unknown) => error instanceof AdvancedSkillPolicyError && error.code === "SKILL_NOT_VERIFIED");
});

test("registry executes verified handlers and emits trace events", async () => {
  const registry = new AdvancedSkillRegistry();
  const events: string[] = [];
  registry.register(definition(), (input: unknown) => ({ echoed: input }));
  const output = await registry.execute("test.skill", "hello", context(false, new AbortController().signal, events));
  assert.deepEqual(output, { echoed: "hello" });
  assert.deepEqual(events, ["skill.started", "skill.completed"]);
});

test("registry requires approval for privileged skills", async () => {
  const registry = new AdvancedSkillRegistry();
  registry.register(definition({ risk: "privileged", requiresApproval: true }), () => "should not run");
  await assert.rejects(registry.execute("test.skill", null, context()),
    (error: unknown) => error instanceof AdvancedSkillPolicyError && error.code === "APPROVAL_REQUIRED");
});

test("registry rejects missing skills and pre-aborted executions", async () => {
  const registry = new AdvancedSkillRegistry();
  await assert.rejects(registry.execute("missing", null, context()),
    (error: unknown) => error instanceof AdvancedSkillPolicyError && error.code === "SKILL_NOT_FOUND");
  registry.register(definition(), () => "should not run");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(registry.execute("test.skill", null, context(false, controller.signal)),
    (error: unknown) => error instanceof AdvancedSkillPolicyError && error.code === "ABORTED");
});

test("registry times out slow handlers", async () => {
  const registry = new AdvancedSkillRegistry();
  registry.register(definition(), () => new Promise((resolve) => setTimeout(() => resolve("late"), 100)));
  await assert.rejects(registry.execute("test.skill", null, context(), { timeoutMs: 5 }),
    (error: unknown) => error instanceof AdvancedSkillPolicyError && error.code === "TIMEOUT");
});
