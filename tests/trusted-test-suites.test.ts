import test from "node:test";
import assert from "node:assert/strict";
import { loadTrustedSkillTestSuite } from "../src/skills/trusted-test-suites.js";
import type { SkillPackage } from "../src/skills/platform.js";

const candidate = {
  source: "learned" as const,
  version: "1",
  skill: {
    id: "skill.alpha", name: "Alpha", description: "Fixture", triggers: ["alpha"],
    categories: ["runtime_error"] as const, strategy: "inspect-evidence" as const,
    procedure: ["inspect", "verify"], verification: ["test"] as const,
  },
} satisfies SkillPackage;

const suite = {
  skillId: "skill.alpha",
  id: "alpha-contract",
  version: "2",
  files: { "alpha.test.mjs": 'import test from "node:test"; test("contract", () => {});' },
  tests: ["alpha.test.mjs"],
};

test("trusted test suite loader selects only the exact skill id", () => {
  const raw = JSON.stringify([{ ...suite, skillId: "skill.other" }, suite]);
  assert.deepEqual(loadTrustedSkillTestSuite(candidate, raw), {
    id: "alpha-contract",
    version: "2",
    files: suite.files,
    tests: suite.tests,
  });
});

test("trusted test suite loader fails closed on duplicate or malformed configuration", () => {
  assert.throws(() => loadTrustedSkillTestSuite(candidate, JSON.stringify([suite, suite])), /Multiple trusted/);
  assert.throws(() => loadTrustedSkillTestSuite(candidate, "{"), /valid JSON/);
  assert.throws(() => loadTrustedSkillTestSuite(candidate, JSON.stringify({ ...suite })), /must be an array/);
});

test("trusted test suite loader returns no suite when operator has not configured one", () => {
  assert.equal(loadTrustedSkillTestSuite(candidate, ""), undefined);
});

test("trusted test suite loader enforces a configuration size bound", () => {
  assert.throws(() => loadTrustedSkillTestSuite(candidate, " ".repeat(512 * 1024 + 1)), /size limit/);
});
