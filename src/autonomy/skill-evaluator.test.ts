import assert from "node:assert/strict";
import test from "node:test";
import type { LearnedSkillCandidate } from "../brain/learning.js";
import { digestSkillCandidate, evaluateSkillCandidate } from "./skill-evaluator.js";

const candidate: LearnedSkillCandidate = {
  name: "repair-build-failure",
  trigger: "A verified build failure occurs.",
  category: "runtime_error",
  strategy: "fix-implementation",
  procedure: ["inspect trusted failure evidence", "apply isolated repair", "run verification"],
  verification: ["typecheck", "test", "build"],
  evidenceIds: ["run-42", "test-42"],
};
const evidence = () => ({
  candidateDigest: digestSkillCandidate(candidate),
  artifactVersion: "skill-artifact-v1",
  testsPassed: true,
  adversarialTestsPassed: true,
  benchmarkScore: 0.95,
  safetyIncidents: 0,
  versionedArtifact: true,
  rollbackAvailable: true,
});

test("skill candidate is eligible only when exact-candidate evidence meets every gate", () => {
  const result = evaluateSkillCandidate(candidate, evidence());
  assert.equal(result.eligible, true);
  assert.equal(result.artifactVersion, "skill-artifact-v1");
  assert.deepEqual(result.reasons, []);
});

test("skill evaluation rejects evidence from a different candidate", () => {
  const changed = { ...candidate, procedure: [...candidate.procedure, "skip verification"] };
  const result = evaluateSkillCandidate(changed, evidence());
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /does not match/i);
});

test("skill evaluation rejects weak benchmark, safety incidents and missing rollback", () => {
  for (const invalid of [
    { ...evidence(), benchmarkScore: 0.89 },
    { ...evidence(), safetyIncidents: 1 },
    { ...evidence(), rollbackAvailable: false },
    { ...evidence(), adversarialTestsPassed: false },
    { ...evidence(), artifactVersion: "" },
  ]) {
    assert.equal(evaluateSkillCandidate(candidate, invalid).eligible, false);
  }
});

test("skill evaluation rejects malformed candidates and missing evidence", () => {
  assert.equal(evaluateSkillCandidate({ ...candidate, evidenceIds: [] }, evidence()).eligible, false);
  assert.equal(evaluateSkillCandidate(candidate, null as never).eligible, false);
});
