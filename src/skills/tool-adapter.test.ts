import test from "node:test";
import assert from "node:assert/strict";
import { SecurityController } from "../security/controller.js";
import { createAdvancedSkillTools } from "./tool-adapter.js";
import { ADVANCED_SKILLS } from "./advanced-skill-catalog.js";

test("verified skill handlers are exposed as tools in the shared Sofia registry", async () => {
  const tools = createAdvancedSkillTools({
    securityController: new SecurityController(),
    principalId: "test:owner",
    projectMemoryStore: {
      async save() {},
      async list() { return []; },
      async find() { return []; },
    },
  });
  const listed = tools.find((tool) => tool.name === "skill.list");
  assert.ok(listed);
  const result = await listed.execute({}, { runtime: {} as never });
  assert.ok(Array.isArray(result));
  const ids = (result as Array<{ id: string }>).map((item) => item.id);
  const verified = ADVANCED_SKILLS.filter((skill) => skill.status === "verified").map((skill) => skill.id).sort();
  assert.deepEqual(ids.filter((id) => verified.includes(id)).sort(), verified);
  for (const id of verified) assert.ok(tools.some((tool) => tool.name === "skill." + id), id);
});

test("skill tool effects retain approval boundaries for write and privileged handlers", () => {
  const tools = createAdvancedSkillTools({
    securityController: new SecurityController(),
    principalId: "test:owner",
  });
  const find = (id: string) => tools.find((tool) => tool.name === "skill." + id);
  assert.ok(find("runtime.01")?.effects?.includes("read"));
  const writable = ADVANCED_SKILLS.find((skill) => skill.status === "verified" && skill.risk === "may-write");
  if (writable) assert.ok(find(writable.id)?.effects?.includes("write"));
  const privileged = ADVANCED_SKILLS.find((skill) => skill.status === "verified" && skill.risk === "privileged");
  if (privileged) assert.ok(find(privileged.id)?.effects?.includes("destructive"));
});
