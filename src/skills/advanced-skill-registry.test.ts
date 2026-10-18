import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectMemoryStore } from "../brain/project-memory.js";
import { ADVANCED_SKILLS } from "./advanced-skill-catalog.js";
import {
  createAdvancedSkillRegistry,
  listUnregisteredVerifiedSkills,
} from "./advanced-skill-registry.js";

const context = () => ({
  principalId: "registry-test",
  signal: new AbortController().signal,
});

test("default registry assembles only verified handlers and reports dependency gaps", () => {
  const registry = createAdvancedSkillRegistry();
  const registered = registry.list();
  assert.ok(registered.length > 0);
  assert.ok(registered.every((skill) => skill.status === "verified"));
  assert.equal(new Set(registered.map((skill) => skill.id)).size, registered.length);
  assert.deepEqual(listUnregisteredVerifiedSkills(registry), ["conversation.04"]);
  assert.equal(registered.length, ADVANCED_SKILLS.filter((skill) => skill.status === "verified").length - 1);
});

test("configured project-memory store makes the verified retrieval skill available", async () => {
  const store: ProjectMemoryStore = {
    async save() {},
    async list() { return []; },
    async find(query) {
      assert.equal(query, "Sofia Agent");
      return [];
    },
  };
  const registry = createAdvancedSkillRegistry({ projectMemoryStore: store });
  assert.deepEqual(listUnregisteredVerifiedSkills(registry), []);
  const result = await registry.execute<{ query: string }, { query: string; entries: unknown[]; count: number }>(
    "conversation.04",
    { query: "Sofia Agent" },
    context(),
  );
  assert.deepEqual(result, { query: "Sofia Agent", entries: [], count: 0 });
});

test("registry factory does not promote implemented or planned catalog entries", () => {
  const registry = createAdvancedSkillRegistry();
  for (const skill of ADVANCED_SKILLS.filter((item) => item.status !== "verified")) {
    assert.equal(registry.has(skill.id), false, skill.id);
  }
});
