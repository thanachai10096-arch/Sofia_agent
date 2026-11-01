import type { LearningScope, RunEvidence, VerificationReceipt } from "./ports.js";

export function validScope(scope: LearningScope): boolean {
  return Boolean(scope && typeof scope.tenantId === "string" && scope.tenantId.trim() &&
    typeof scope.principalId === "string" && scope.principalId.trim() &&
    typeof scope.projectId === "string" && scope.projectId.trim());
}
export function sameScope(a: LearningScope, b: LearningScope): boolean {
  return validScope(a) && validScope(b) &&
    a.tenantId === b.tenantId && a.principalId === b.principalId && a.projectId === b.projectId;
}
export function validReceipt(receipt: VerificationReceipt, scope: LearningScope, now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000): boolean {
  if (!receipt || typeof receipt !== "object" || !validScope(scope) || !validScope(receipt.scope) ||
      typeof receipt.completedAt !== "string" || !Number.isFinite(now) ||
      !Number.isFinite(maxAgeMs) || maxAgeMs < 1) return false;
  const completedAt = Date.parse(receipt.completedAt);
  return receipt.completed === true && receipt.verified === true &&
    typeof receipt.id === "string" && receipt.id.length > 0 &&
    typeof receipt.runId === "string" && receipt.runId.length > 0 &&
    sameScope(receipt.scope, scope) &&
    typeof receipt.verifier === "string" && receipt.verifier.trim().length > 0 &&
    typeof receipt.policyRevision === "string" && receipt.policyRevision.length > 0 &&
    Array.isArray(receipt.evidenceIds) && receipt.evidenceIds.length > 0 &&
    receipt.evidenceIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 500) &&
    Number.isFinite(completedAt) && completedAt <= now && now - completedAt <= maxAgeMs;
}
export function validEvidence(evidence: RunEvidence, receipt: VerificationReceipt): boolean {
  if (!evidence || typeof evidence !== "object" || !receipt || typeof receipt !== "object" ||
      !validScope(evidence.scope) || !validScope(receipt.scope) ||
      !Array.isArray(receipt.evidenceIds) || typeof evidence.id !== "string" ||
      typeof evidence.runId !== "string") return false;
  return evidence.trusted === true && evidence.success === true &&
    evidence.runId === receipt.runId && sameScope(evidence.scope, receipt.scope) &&
    receipt.evidenceIds.includes(evidence.id) &&
    ["tool-result", "verification", "regression"].includes(evidence.kind);
}
export function normalizeText(value: string, maxChars: number): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maxChars);
}
