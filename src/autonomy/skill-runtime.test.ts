import assert from "node:assert/strict";
import test from "node:test";
import type { LearnedSkillCandidate } from "../brain/learning.js";
import { digestSkillCandidate } from "./skill-evaluator.js";
import { InMemorySkillRegistryStore, ControlledSkillRegistry } from "./skill-registry.js";
import { SkillRuntime } from "./skill-runtime.js";
import type { SkillCandidateEvaluationEvidence } from "./skill-evaluator.js";

const identity = { actor: "runtime-user", scope: "runtime-project" };
const candidate: LearnedSkillCandidate = {
  name: "repair-build-failure",
  trigger: "A verified build failure occurs.",
  category: "runtime_error",
  strategy: "fix-implementation",
  procedure: ["inspect evidence", "apply isolated repair", "verify result"],
  verification: ["typecheck", "test", "build"],
  evidenceIds: ["evidence-1"],
};
const evidence: SkillCandidateEvaluationEvidence = {
  candidateDigest: digestSkillCandidate(candidate),
  artifactVersion: "v1",
  testsPassed: true,
  adversarialTestsPassed: true,
  benchmarkScore: 0.95,
  safetyIncidents: 0,
  versionedArtifact: true,
  rollbackAvailable: true,
};

test("runtime resolves only the active skill with matching verified evidence", async () => {
  const store = new InMemorySkillRegistryStore();
  const registry = new ControlledSkillRegistry(store);
  await registry.promote({ identity, candidate, evidence, expectedActiveVersion: null });
  const resolved = await new SkillRuntime(store).resolve(identity, candidate.name);
  assert.equal(resolved?.version, "v1");
  assert.deepEqual(resolved?.procedure, candidate.procedure);
});

test("runtime rejects missing, unapproved, tampered and cross-scope skills", async () => {
  const store = new InMemorySkillRegistryStore();
  const runtime = new SkillRuntime(store);
  assert.equal(await runtime.resolve(identity, candidate.name), null);
  const registry = new ControlledSkillRegistry(store);
  await registry.promote({ identity, candidate, evidence, expectedActiveVersion: null });
  assert.equal(await runtime.resolve({ actor: "other-user", scope: "other-project" }, candidate.name), null);
  await store.transact(identity.scope, (state) => {
    state.versions[candidate.name]![0]!.evidence.benchmarkScore = 0.2;
  });
  assert.equal(await runtime.resolve(identity, candidate.name), null);
});

test("runtime rejects malformed identity and never treats a non-active version as active", async () => {
  const store = new InMemorySkillRegistryStore();
  const registry = new ControlledSkillRegistry(store);
  await registry.promote({ identity, candidate, evidence, expectedActiveVersion: null });
  const runtime = new SkillRuntime(store);
  assert.equal(await runtime.resolve({ actor: " ", scope: identity.scope }, candidate.name), null);
  await store.transact(identity.scope, (state) => { delete state.active[candidate.name]; });
  assert.equal(await runtime.resolve(identity, candidate.name), null);
});
