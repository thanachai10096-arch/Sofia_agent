import test from "node:test";
import assert from "node:assert/strict";
import { sameScope, validEvidence, validReceipt, validScope } from "./validation.js";
import type { LearningScope, RunEvidence, VerificationReceipt } from "./ports.js";

const scope: LearningScope = { tenantId: "tenant-a", principalId: "user-a", projectId: "project-a" };
const receipt: VerificationReceipt = {
  id: "receipt-1", runId: "run-1", scope, completed: true, verified: true,
  verifier: "sofia-verifier", evidenceIds: ["evidence-1"], policyRevision: "policy-1",
  completedAt: new Date().toISOString(),
};
test("validates complete authenticated scopes and isolates tenants/users/projects", () => {
  assert.equal(validScope(scope), true);
  assert.equal(sameScope(scope, { ...scope, tenantId: "tenant-b" }), false);
  assert.equal(sameScope(scope, { ...scope, principalId: "user-b" }), false);
  assert.equal(sameScope(scope, { ...scope, projectId: "project-b" }), false);
  assert.equal(validScope({ ...scope, principalId: " " }), false);
});
test("accepts only recent, successful, verified receipts in the exact scope", () => {
  assert.equal(validReceipt(receipt, scope), true);
  assert.equal(validReceipt({ ...receipt, verified: false }, scope), false);
  assert.equal(validReceipt({ ...receipt, scope: { ...scope, tenantId: "other" } }, scope), false);
  assert.equal(validReceipt({ ...receipt, completedAt: new Date(Date.now() + 10000).toISOString() }, scope), false);
  assert.equal(validReceipt({ ...receipt, completedAt: new Date(Date.now() - 9 * 86400000).toISOString() }, scope), false);
});
test("fails closed for malformed persisted receipt and evidence objects", () => {
  assert.equal(validReceipt(null as unknown as VerificationReceipt, scope), false);
  assert.equal(validReceipt({ ...receipt, scope: undefined } as unknown as VerificationReceipt, scope), false);
  assert.equal(validReceipt({ ...receipt, completedAt: undefined } as unknown as VerificationReceipt, scope), false);

  const evidence: RunEvidence = {
    id: "evidence-1", runId: "run-1", scope, kind: "verification", trusted: true,
    success: true, content: "verified", createdAt: new Date().toISOString(),
  };
  assert.equal(validEvidence(null as unknown as RunEvidence, receipt), false);
  assert.equal(validEvidence({ ...evidence, scope: undefined } as unknown as RunEvidence, receipt), false);
});

test("evidence must be trusted, successful, same-run and explicitly referenced", () => {
  const evidence: RunEvidence = {
    id: "evidence-1", runId: "run-1", scope, kind: "verification", trusted: true,
    success: true, content: "verified", createdAt: new Date().toISOString(),
  };
  assert.equal(validEvidence(evidence, receipt), true);
  assert.equal(validEvidence({ ...evidence, trusted: false }, receipt), false);
  assert.equal(validEvidence({ ...evidence, runId: "other-run" }, receipt), false);
  assert.equal(validEvidence({ ...evidence, id: "unreferenced" }, receipt), false);
});
