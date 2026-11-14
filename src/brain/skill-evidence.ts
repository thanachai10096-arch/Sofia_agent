import type { SecurityAuditEvent } from "../security/audit.js";
import type { SkillPackage } from "../skills/platform.js";
import type { SkillEvaluationCheck, SkillProvenance } from "./skill-lifecycle.js";

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
    if (!Array.isArray(provenance.evidenceIds) || provenance.evidenceIds.length < requiredKinds.length) {
      return [{ name: "trusted-evidence-count", passed: false, detail: "All three project verification records are required." }];
    }

    let events: readonly SecurityAuditEvent[];
    try {
      events = await this.readEvents();
    } catch {
      return [{ name: "trusted-evidence-store", passed: false, detail: "Trusted audit evidence could not be read." }];
    }

    const byId = new Map(events.map((event) => [event.id, event]));
    const checks: SkillEvaluationCheck[] = [];
    const verifiedKinds = new Set<string>();
    for (const evidenceId of provenance.evidenceIds) {
      const event = byId.get(evidenceId);
      const input = event?.input;
      const result = event?.result;
      const kind = record(input) && typeof input.kind === "string" ? input.kind : "";
      const valid = Boolean(
        event &&
        event.runId === provenance.runId &&
        event.toolName === "project.verify" &&
        event.decision === "completed" &&
        requiredKinds.includes(kind as typeof requiredKinds[number]) &&
        record(result) &&
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
