import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySkillsPlatform } from "./platform.js";
import { createSkillsTools } from "./tools.js";
import type { SkillPackage } from "./platform.js";

const skill: SkillPackage = {
  source: "builtin",
  version: "1.0.0",
  publisher: "sofia",
  skill: {
    id: "typescript-error-repair",
    name: "TypeScript error repair",
    description: "Diagnose and repair TypeScript compiler failures.",
    triggers: ["TS", "not assignable"],
    categories: ["type_error", "syntax_error"],
    strategy: "fix-implementation",
    procedure: ["inspect compiler output", "locate the source", "make the smallest fix", "run typecheck"],
    verification: ["typecheck"],
  },
};

test("skills_list returns compact metadata without loading procedure details", async () => {
  const platform = new InMemorySkillsPlatform();
  platform.register(skill);
  const [list] = createSkillsTools(platform);
  const result = await list!.execute({ query: "typescript", limit: 10 }, { runtime: {} as never }) as {
    count: number;
    skills: Array<Record<string, unknown>>;
  };
  assert.equal(result.count, 1);
  assert.equal(result.skills[0]?.id, skill.skill.id);
  assert.equal("procedure" in (result.skills[0] ?? {}), false);
});

test("skill_view loads the full selected procedure and labels it as untrusted guidance", async () => {
  const platform = new InMemorySkillsPlatform();
  platform.register(skill);
  const [, view] = createSkillsTools(platform);
  const result = await view!.execute({ id: skill.skill.id }, { runtime: {} as never }) as {
    procedure: string[];
    verification: string[];
    trust: string;
  };
  assert.deepEqual(result.procedure, skill.skill.procedure);
  assert.deepEqual(result.verification, skill.skill.verification);
  assert.equal(result.trust, "untrusted_reference_guidance");
});

test("skill_view refuses unknown IDs and skills_list filters by source", async () => {
  const platform = new InMemorySkillsPlatform();
  platform.register(skill);
  const [list, view] = createSkillsTools(platform);
  const filtered = await list!.execute({ source: "learned" }, { runtime: {} as never }) as { count: number };
  assert.equal(filtered.count, 0);
  await assert.rejects(() => view!.execute({ id: "not-installed" }, { runtime: {} as never }), /Unknown skill ID/);
});
