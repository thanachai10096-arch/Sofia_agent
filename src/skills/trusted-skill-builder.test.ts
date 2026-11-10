import assert from "node:assert/strict";
import test from "node:test";
import type { LearnedSkillCandidate } from "../brain/learning.js";
import { buildTrustedSkillArtifact } from "./trusted-skill-builder.js";

const base: LearnedSkillCandidate = {
  name: "project-safe-fields",
  trigger: "project selected fields",
  category: "runtime_error",
  strategy: "fix-implementation",
  procedure: ["inspect input", "return selected fields"],
  verification: ["test"],
  evidenceIds: ["evidence-1"],
};

test("trusted builder compiles a valid declarative plan deterministically", () => {
  const candidate = {
    ...base,
    dsl: { version: 1, operation: "project-fields", fields: ["name", "status"] },
  };
  const first = buildTrustedSkillArtifact(candidate);
  const second = buildTrustedSkillArtifact(candidate);
  assert.deepEqual(first, second);
  assert.equal(first?.entrypoint, "index.mjs");
  assert.match(first?.files["index.mjs"] ?? "", /export function run/);
  assert.match(first?.files["index.mjs"] ?? "", /Object\.hasOwn/);
  assert.doesNotMatch(first?.files["index.mjs"] ?? "", /eval\s*\(/);
});

test("trusted builder rejects prose-only, unknown, and malformed plans", () => {
  assert.equal(buildTrustedSkillArtifact(base), undefined);
  assert.equal(buildTrustedSkillArtifact({
    ...base,
    dsl: { version: 1, operation: "shell", command: "rm -rf /" },
  }), undefined);
  assert.equal(buildTrustedSkillArtifact({
    ...base,
    dsl: { version: 1, operation: "project-fields", fields: ["__proto__"] },
  }), undefined);
  assert.equal(buildTrustedSkillArtifact({
    ...base,
    dsl: { version: 1, operation: "project-fields", fields: ["same", "same"] },
  }), undefined);
  assert.equal(buildTrustedSkillArtifact({
    ...base,
    dsl: { version: 1, operation: "project-fields", fields: ["x"], extra: true },
  }), undefined);
});
