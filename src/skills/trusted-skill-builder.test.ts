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

test("trusted builder compiles a valid declarative plan deterministically", async () => {
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
  const source = first?.files["index.mjs"];
  assert.ok(source);
  const loaded = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64")) as { run(input: unknown): unknown };
  assert.deepEqual(loaded.run({ name: "Sofia", status: "ready", secret: "omit" }), { name: "Sofia", status: "ready" });
  assert.throws(() => loaded.run(["not", "an", "object"]), /expects a JSON object/);
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
  assert.equal(buildTrustedSkillArtifact({
    ...base,
    dsl: { version: 1, operation: "project-fields", fields: Array.from({ length: 33 }, (_, i) => "f" + i) },
  }), undefined);
  assert.equal(buildTrustedSkillArtifact({
    ...base,
    dsl: { version: 1, operation: "project-fields", fields: ["x".repeat(129)] },
  }), undefined);
  }), undefined);
});
