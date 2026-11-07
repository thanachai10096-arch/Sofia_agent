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
  assert.ok(readOnly);
  assert.ok(mayWrite);
  const registry = new AdvancedSkillRegistry();
  registry.register(readOnly, async () => "read");
  registry.register(mayWrite, async () => "write");
  const tools = createAdvancedSkillTools(registry, "principal-test");

  assert.deepEqual(tools.find((tool) => tool.name === `skill.${readOnly.id}`)?.effects, ["read"]);
  assert.deepEqual(tools.find((tool) => tool.name === `skill.${mayWrite.id}`)?.effects, ["write"]);
});

test("approval-required skills stay fail-closed when no trusted approval is provided", async () => {
  const definition = ADVANCED_SKILLS.find((skill) => skill.status === "verified" && skill.requiresApproval);
  if (!definition) {
    // The current verified catalog has no approval-required entries; this test
    // still guards the registry contract when one is added in a future revision.
    return;
  }
  const registry = new AdvancedSkillRegistry();
  registry.register(definition, async () => "must not run");
  const tool = createAdvancedSkillTools(registry, "principal-test").find((item) => item.name === `skill.${definition.id}`);
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute({}, { runtime: {} as never, signal: new AbortController().signal }),
    { code: "APPROVAL_REQUIRED" },
  );
});
