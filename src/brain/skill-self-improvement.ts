import { createHash } from "node:crypto";
import { redactSecrets } from "../security/guard.js";
import type { SkillPackage } from "../skills/platform.js";
import type { SkillLifecycleRecord, SkillProvenance, VersionedSkillLifecycle } from "./skill-lifecycle.js";
import { runSkillLifecycleWorkflow } from "./skill-lifecycle-workflow.js";

export interface SkillImprovementEvidence {
  readonly id: string;
  readonly skillId: string;
  readonly category: string;
  readonly summary: string;
  readonly verified: boolean;
}
export interface SkillImprovementProposal {
  readonly skillPackage: SkillPackage;
  readonly provenance: SkillProvenance;
}
export interface SkillImprovementPlanner {
  propose(evidence: readonly SkillImprovementEvidence[]): Promise<readonly SkillImprovementProposal[]>;
}
export interface SkillSelfImprovementOptions {
  readonly maxEvidence: number;
  readonly maxProposalsPerRun: number;
  readonly maxSummaryLength: number;
  readonly approvePromotion: (candidate: SkillLifecycleRecord) => Promise<boolean>;
}
export interface SkillImprovementItemResult {
  readonly skillId: string;
  readonly candidateId?: string;
  readonly outcome: "promoted" | "evaluation_rejected" | "approval_declined" | "duplicate" | "invalid";
  readonly reason?: string;
}
export interface SkillSelfImprovementReport {
  readonly runId: string;
  readonly consideredEvidence: number;
  readonly proposalCount: number;
  readonly promoted: number;
  readonly rejected: number;
  readonly items: readonly SkillImprovementItemResult[];
  readonly completedAt: string;
}
const DEFAULTS: SkillSelfImprovementOptions = {
  maxEvidence: 64, maxProposalsPerRun: 3, maxSummaryLength: 1000,
  approvePromotion: async () => false,
};
function boundedInteger(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function validateEvidence(input: readonly SkillImprovementEvidence[], options: SkillSelfImprovementOptions): SkillImprovementEvidence[] {
  if (!Array.isArray(input) || input.length > options.maxEvidence) throw new RangeError(`Self-improvement accepts at most ${options.maxEvidence} evidence items`);
  const seen = new Set<string>();
  return input.map((item) => {
    if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 200 ||
        typeof item.skillId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(item.skillId) ||
        typeof item.category !== "string" || !item.category.trim() || item.category.length > 100 ||
        typeof item.summary !== "string" || !item.summary.trim() || item.summary.length > options.maxSummaryLength ||
        typeof item.verified !== "boolean") throw new TypeError("Invalid skill improvement evidence");
    if (seen.has(item.id)) throw new TypeError("Duplicate skill improvement evidence id");
    seen.add(item.id);
    return { id: item.id, skillId: item.skillId, category: item.category,
      summary: String(redactSecrets(item.summary)), verified: item.verified };
  });
}

/** Bounded candidate orchestration. It never executes generated skill content. */
export class SkillSelfImprovementLoop {
  private readonly options: SkillSelfImprovementOptions;
  constructor(
    private readonly lifecycle: VersionedSkillLifecycle,
    private readonly planner: SkillImprovementPlanner,
    options: Partial<SkillSelfImprovementOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    if (!boundedInteger(this.options.maxEvidence, 1, 256) ||
        !boundedInteger(this.options.maxProposalsPerRun, 1, 16) ||
        !boundedInteger(this.options.maxSummaryLength, 1, 4000) ||
        typeof this.options.approvePromotion !== "function") throw new RangeError("Invalid skill self-improvement policy");
  }

  async run(input: readonly SkillImprovementEvidence[]): Promise<SkillSelfImprovementReport> {
    const evidence = validateEvidence(input, this.options);
    const trusted = evidence.filter((item) => item.verified);
    const runId = createHash("sha256").update(trusted.map((item) => item.id).sort().join("\n")).digest("hex").slice(0, 24);
    if (trusted.length === 0) return {
      runId, consideredEvidence: evidence.length, proposalCount: 0, promoted: 0,
      rejected: 0, items: [], completedAt: new Date().toISOString(),
    };

    const generated = await this.planner.propose(trusted);
    if (!Array.isArray(generated)) throw new TypeError("Skill improvement planner must return an array");
    const proposals = generated.slice(0, this.options.maxProposalsPerRun);
    const items: SkillImprovementItemResult[] = [];
    for (const proposal of proposals) {
      const skillId = proposal?.skillPackage?.skill?.id ?? "unknown";
      try {
        if (!proposal?.skillPackage || !proposal.provenance || !Array.isArray(proposal.provenance.evidenceIds)) {
          items.push({ skillId, outcome: "invalid", reason: "Malformed proposal" }); continue;
        }
        const relevant = trusted.filter((item) => item.skillId === skillId);
        if (relevant.length === 0) {
          items.push({ skillId, outcome: "invalid", reason: "No verified evidence for proposed skill" }); continue;
        }
        const ids = [...new Set(relevant.map((item) => item.id))].sort();
        const supplied = [...proposal.provenance.evidenceIds].sort();
        if (ids.length !== supplied.length || ids.some((id, index) => id !== supplied[index])) {
          items.push({ skillId, outcome: "invalid", reason: "Provenance does not match verified evidence" }); continue;
        }
        const digest = createHash("sha256").update(JSON.stringify(proposal.skillPackage)).digest("hex");
        const duplicate = this.lifecycle.list(skillId).find((record) =>
          createHash("sha256").update(JSON.stringify(record.package)).digest("hex") === digest &&
          record.provenance.evidenceIds.length === ids.length &&
          [...record.provenance.evidenceIds].sort().every((id, index) => id === ids[index]));
        if (duplicate) {
          items.push({ skillId, candidateId: duplicate.id, outcome: "duplicate", reason: `Existing record is ${duplicate.status}` }); continue;
        }
        const provenance: SkillProvenance = {
          source: "skill-self-improvement-loop", evidenceIds: ids,
          confidence: proposal.provenance.confidence,
        };
        const result = await runSkillLifecycleWorkflow(this.lifecycle, proposal.skillPackage, provenance, {
          approvePromotion: this.options.approvePromotion,
        });
        items.push({
          skillId, candidateId: result.candidate.id,
          outcome: result.reason === "promoted" ? "promoted" :
            result.reason === "evaluation_rejected" ? "evaluation_rejected" : "approval_declined",
        });
      } catch (error) {
        items.push({ skillId, outcome: "invalid",
          reason: error instanceof Error ? String(redactSecrets(error.message)).slice(0, 500) : "Proposal processing failed" });
      }
    }
    return {
      runId, consideredEvidence: evidence.length, proposalCount: proposals.length,
      promoted: items.filter((item) => item.outcome === "promoted").length,
      rejected: items.filter((item) => item.outcome === "evaluation_rejected" || item.outcome === "invalid").length,
      items, completedAt: new Date().toISOString(),
    };
  }
}
