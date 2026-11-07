import test from "node:test";
import assert from "node:assert/strict";
import { ADVANCED_SKILLS } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";
import { createAdvancedSkillTools } from "./tools.js";

test("advanced skill tools expose only registered verified handlers", async () => {
  const definition = ADVANCED_SKILLS.find((skill) => skill.id === "runtime.01");
  assert.ok(definition);
  const registry = new AdvancedSkillRegistry();
  registry.register(definition, async (input) => ({ accepted: true, input }));
  const tools = createAdvancedSkillTools(registry, "principal-test");

  assert.deepEqual(tools.map((tool) => tool.name), ["skills.list", "skill.runtime.01"]);
  const listing = await tools[0]!.execute({}, { runtime: {} as never });
  assert.deepEqual(listing, {
    registered: [definition],
    unregisteredVerified: ADVANCED_SKILLS
      .filter((skill) => skill.status === "verified" && skill.id !== definition.id)
      .map((skill) => skill.id)
      .sort(),
  });

  const result = await tools[1]!.execute(
    { goal: "inspect" },
    { runtime: {} as never, signal: new AbortController().signal },
  );
  assert.deepEqual(result, { accepted: true, input: { goal: "inspect" } });
});

test("advanced skill tool effects preserve declared risk for the policy gateway", () => {
  const readOnly = ADVANCED_SKILLS.find((skill) => skill.risk === "read-only" && skill.status === "verified");
  const mayWrite = ADVANCED_SKILLS.find((skill) => skill.risk === "may-write" && skill.status === "verified");
  const privileged = ADVANCED_SKILLS.find((skill) => skill.risk === "privileged" && skill.status === "verified");
  assert.ok(readOnly);
  assert.ok(mayWrite);
  const registry = new AdvancedSkillRegistry();
  registry.register(readOnly, async () => "read");
  registry.register(mayWrite, async () => "write");
  if (privileged) registry.register(privileged, async () => "privileged");
  const tools = createAdvancedSkillTools(registry, "principal-test");

  assert.deepEqual(tools.find((tool) => tool.name === `skill.${readOnly.id}`)?.effects, ["read"]);
  assert.deepEqual(tools.find((tool) => tool.name === `skill.${mayWrite.id}`)?.effects, ["write"]);
  if (privileged) {
    assert.deepEqual(tools.find((tool) => tool.name === `skill.${privileged.id}`)?.effects, ["destructive"]);
  }
});

test("approval-required skills fail closed without trusted action-bound approval evidence", async () => {
  const base = ADVANCED_SKILLS.find((skill) => skill.status === "verified");
  assert.ok(base);
  // Use synthetic metadata so this contract remains tested even while the
  // current verified catalog intentionally contains no approval-required skill.
  const definition = {
    ...base,
    id: "test.approval-required",
    risk: "privileged" as const,
    requiresApproval: true,
  };
  let handlerCalled = false;
  const registry = new AdvancedSkillRegistry();
  registry.register(definition, async () => {
    handlerCalled = true;
    return "must not run";
  });
  const tool = createAdvancedSkillTools(registry, "principal-test").find(
    (item) => item.name === `skill.${definition.id}`,
  );
  assert.ok(tool);
  assert.deepEqual(tool.effects, ["destructive"]);
  await assert.rejects(
    () => tool.execute({}, { runtime: {} as never, signal: new AbortController().signal }),
    { code: "APPROVAL_REQUIRED" },
  );
  assert.equal(handlerCalled, false);
});

test("privileged skill accepts only matching one-run action-bound approval evidence", async () => {
  const base = ADVANCED_SKILLS.find((skill) => skill.status === "verified");
  assert.ok(base);
  const definition = {
    ...base,
    id: "test.action-bound-approval",
    risk: "privileged" as const,
    requiresApproval: true,
  };
  let handlerCalls = 0;
  const expected = {
    requestId: "approval-once",
    runId: "run-123",
    principalId: "principal-test",
    toolName: `skill.${definition.id}`,
    actionHash: "sha256:approved-action",
  };
  const registry = new AdvancedSkillRegistry((request) =>
    request.requestId === expected.requestId &&
    request.runId === expected.runId &&
    request.principalId === expected.principalId &&
    request.toolName === expected.toolName &&
    request.actionHash === expected.actionHash &&
    request.skillId === definition.id,
  );
  registry.register(definition, async () => {
    handlerCalls += 1;
    return "executed";
  });
  const tool = createAdvancedSkillTools(registry, "principal-test").find(
    (item) => item.name === expected.toolName,
  );
  assert.ok(tool);

  await assert.rejects(
    () => tool.execute({}, {
      runtime: {} as never,
      approval: { ...expected, actionHash: "sha256:changed-action" },
    }),
    { code: "APPROVAL_REQUIRED" },
  );
  assert.equal(handlerCalls, 0);

  const result = await tool.execute({}, {
    runtime: {} as never,
    approval: expected,
  });
  assert.equal(result, "executed");
  assert.equal(handlerCalls, 1);
});
