import assert from "node:assert/strict";
import test from "node:test";
import type { LearnedSkillCandidate } from "../brain/learning.js";
import { digestSkillCandidate } from "./skill-evaluator.js";
import {
  ControlledSkillRegistry,
  InMemorySkillRegistryStore,
  type SkillCandidateEvaluationEvidence,
} from "./skill-registry.js";

const candidate: LearnedSkillCandidate = {
  name: "repair-build-failure",
  trigger: "A verified build failure occurs.",
  category: "runtime_error",
  strategy: "fix-implementation",
  procedure: ["inspect trusted failure evidence", "apply isolated repair", "run verification"],
  verification: ["typecheck", "test", "build"],
  evidenceIds: ["run-42", "test-42"],
};
function evidence(version: string): SkillCandidateEvaluationEvidence {
  return {
    candidateDigest: digestSkillCandidate(candidate),
    artifactVersion: version,
    testsPassed: true,
    adversarialTestsPassed: true,
    benchmarkScore: 0.95,
    safetyIncidents: 0,
    versionedArtifact: true,
    rollbackAvailable: true,
  };
}
const identity = { actor: "user-1", scope: "project-a" };

test("registry promotes only eligible evidence and records an immutable version", async () => {
  const registry = new ControlledSkillRegistry(new InMemorySkillRegistryStore());
  const result = await registry.promote({ identity, candidate, evidence: evidence("v1"), expectedActiveVersion: null });
  assert.equal(result.ok, true);
  assert.equal((await registry.getActive(identity, candidate.name))?.version, "v1");
  assert.equal((await registry.listAudit(identity)).length, 1);
});

test("registry rejects failed evidence, stale writes and duplicate artifact versions", async () => {
  const registry = new ControlledSkillRegistry(new InMemorySkillRegistryStore());
  const weak = { ...evidence("v1"), benchmarkScore: 0.5 };
  assert.equal((await registry.promote({ identity, candidate, evidence: weak, expectedActiveVersion: null })).ok, false);
  assert.equal((await registry.promote({ identity, candidate, evidence: evidence("v1"), expectedActiveVersion: null })).ok, true);
  assert.equal((await registry.promote({ identity, candidate, evidence: evidence("v2"), expectedActiveVersion: null })).ok, false);
  assert.equal((await registry.promote({ identity, candidate, evidence: evidence("v1"), expectedActiveVersion: "v1" })).ok, false);
});

test("registry rollback restores a prior version and audits the transition", async () => {
  const registry = new ControlledSkillRegistry(new InMemorySkillRegistryStore());
  await registry.promote({ identity, candidate, evidence: evidence("v1"), expectedActiveVersion: null });
  const changed = { ...candidate, procedure: [...candidate.procedure, "confirm no side effects"] };
  const v2Evidence = { ...evidence("v2"), candidateDigest: digestSkillCandidate(changed) };
  assert.equal((await registry.promote({ identity, candidate: changed, evidence: v2Evidence, expectedActiveVersion: "v1" })).ok, true);
  assert.equal((await registry.rollback(identity, candidate.name, "v1")).ok, true);
  assert.equal((await registry.getActive(identity, candidate.name))?.version, "v1");
  assert.equal((await registry.listAudit(identity)).at(-1)?.action, "rolled-back");
});

test("registry scopes isolate tenants and reject unknown rollback targets", async () => {
  const registry = new ControlledSkillRegistry(new InMemorySkillRegistryStore());
  await registry.promote({ identity, candidate, evidence: evidence("v1"), expectedActiveVersion: null });
  assert.equal(await registry.getActive({ actor: "user-2", scope: "project-b" }, candidate.name), null);
  assert.equal((await registry.rollback({ actor: "user-2", scope: "project-b" }, candidate.name, "v1")).ok, false);
});

test("concurrent promotions use optimistic concurrency so only one wins", async () => {
  const registry = new ControlledSkillRegistry(new InMemorySkillRegistryStore());
  const results = await Promise.all([
    registry.promote({ identity, candidate, evidence: evidence("v1"), expectedActiveVersion: null }),
    registry.promote({ identity, candidate, evidence: evidence("v2"), expectedActiveVersion: null }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
});
