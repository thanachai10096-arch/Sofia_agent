import { createHash } from "node:crypto";
import { actionHash as computeActionHash, canonicalJson } from "../security/guard.js";
import type { SecurityAuditEvent } from "../security/audit.js";
import type { SkillPackage } from "../skills/platform.js";
import type { SkillEvaluationCheck, SkillProvenance } from "./skill-lifecycle.js";

/** Stable SHA-256 identity for the exact learned Skill artifact. */
export function skillPackageDigest(skill: SkillPackage): string {
  return createHash("sha256").update(canonicalJson(skill)).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolves caller-supplied evidence IDs against Sofia's trusted audit stream.
 * A valid identifier alone is never treated as proof of a successful verification.
 */
export class AuditSkillEvidenceVerifier {
  constructor(private readonly readEvents: () => Promise<readonly SecurityAuditEvent[]>) {}

  async verify(skill: SkillPackage, provenance: SkillProvenance): Promise<SkillEvaluationCheck[]> {
    const requiredKinds = ["typecheck", "test", "build"] as const;
    if (provenance.source !== "verified-brain-repair" || !provenance.runId?.trim()) {
      return [{ name: "trusted-evidence-provenance", passed: false, detail: "Missing trusted Brain run provenance." }];
    }
    if (typeof provenance.skillDigest !== "string" || !/^[a-f0-9]{64}$/.test(provenance.skillDigest) || provenance.skillDigest !== skillPackageDigest(skill)) {
      return [{ name: "skill-artifact-digest", passed: false, detail: "Trusted provenance does not match the exact Skill package being evaluated." }];
    }
    if (!Array.isArray(provenance.evidenceIds) || provenance.evidenceIds.length !== requiredKinds.length ||
        !provenance.evidenceIds.every((id) => typeof id === "string" && id.trim().length > 0) ||
        new Set(provenance.evidenceIds).size !== requiredKinds.length) {
      return [{ name: "trusted-evidence-count", passed: false, detail: "Exactly one unique evidence ID for each of the three project verification records is required." }];
    }

    let events: readonly SecurityAuditEvent[];
    try {
      events = await this.readEvents();
    } catch {
      return [{ name: "trusted-evidence-store", passed: false, detail: "Trusted audit evidence could not be read." }];
    }

    const attestations = events.filter((event) => event.runId === provenance.runId && event.toolName === "skill.candidate.attest");
    if (attestations.length !== 1 || typeof attestations[0]?.principalId !== "string" || !attestations[0].principalId.trim()) {
      return [{ name: "trusted-evidence-principal", passed: false, detail: "A unique attestation with an authenticated principal is required." }];
    }
    const attestation = attestations[0];
    const attestationInput = attestation?.input;
    const attestationResult = attestation?.result;
    const attestationMatches = Boolean(
      attestations.length === 1 &&
      attestation &&
      attestation.decision === "completed" &&
      typeof attestation.actionHash === "string" &&
      record(attestationInput) &&
      attestationInput.skillId === skill.skill.id &&
      attestationInput.skillDigest === provenance.skillDigest &&
      attestation.actionHash === computeActionHash(provenance.runId, "skill.candidate.attest", attestationInput, attestation.principalId) &&
      Array.isArray(attestationInput.evidenceIds) &&
      attestationInput.evidenceIds.length === provenance.evidenceIds.length &&
      provenance.evidenceIds.every((id, index) => attestationInput.evidenceIds[index] === id) &&
      record(attestationResult) &&
      attestationResult.passed === true &&
      attestationResult.skillDigest === provenance.skillDigest
    );
    // The exact artifact digest and its evidence IDs must be bound by a durable
    // app-generated audit attestation in the same Brain run.
    if (!attestationMatches) {
      return [{ name: "skill-artifact-attestation", passed: false, detail: "No unique trusted audit attestation binds this exact Skill digest to its verification evidence." }];
    }

    // The composite audit sink intentionally stores the same event in memory and
    // encrypted persistence. Accept identical copies, but reject conflicting records
    // that reuse an evidence ID so storage ordering can never choose the trusted event.
    const byId = new Map<string, SecurityAuditEvent[]>();
    for (const event of events) {
      const copies = byId.get(event.id) ?? [];
      copies.push(event);
      byId.set(event.id, copies);
    }
    const checks: SkillEvaluationCheck[] = [];
    const verifiedKinds = new Set<string>();
    for (const evidenceId of provenance.evidenceIds) {
      const copies = byId.get(evidenceId) ?? [];
      const event = copies[0];
      const input = event?.input;
      const result = event?.result;
      // Replicated audit sinks may contain exact copies. Any field-level
      // disagreement (including principal, risk, timestamp, reason, or payload
      // fields not interpreted below) makes the evidence ambiguous and invalid.
      const duplicateRecordsAgree = copies.every((copy) =>
        event !== undefined && canonicalJson(copy) === canonicalJson(event)
      );
      const kind = record(input) && typeof input.kind === "string" ? input.kind : "";
      const valid = Boolean(
        event &&
        copies.length > 0 &&
        duplicateRecordsAgree &&
        event.id === evidenceId &&
        event.runId === provenance.runId &&
        event.principalId === attestation?.principalId &&
        event.toolName === "project.verify" &&
        record(input) &&
        event.actionHash === computeActionHash(event.runId, event.toolName, input, event.principalId) &&
        event.decision === "completed" &&
        requiredKinds.includes(kind as typeof requiredKinds[number]) &&
        record(result) &&
        result.kind === kind &&
        result.passed === true &&
        result.code === 0
      );
      if (valid) verifiedKinds.add(kind);
      checks.push({
        name: "evidence:" + evidenceId,
        passed: valid,
        detail: valid ? "Trusted " + kind + " verification passed." : "Evidence ID did not resolve to a successful verification from this Brain run.",
      });
    }

    for (const kind of requiredKinds) {
      const passed = verifiedKinds.has(kind);
      checks.push({
        name: "required-verification:" + kind,
        passed,
        detail: passed ? kind + " is backed by trusted audit evidence." : "Missing trusted successful " + kind + " evidence.",
      });
    }
    checks.push({
      name: "skill-verification-contract",
      passed: requiredKinds.every((kind) => skill.skill.verification.includes(kind)),
      detail: "Learned skill must retain typecheck, test, and build verification requirements.",
    });
    return checks;
  }
}
