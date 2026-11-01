import type { ActiveLearningSkill, LearningScope } from "./ports.js";
import {
  reconcileLearningActivationState,
  type LearningReconciliationIssue,
  type LearningReconciliationReport,
  type RuntimeLearningSkill,
} from "./reconciliation.js";

export type LearningRecoveryDisposition =
  | "healthy"
  | "eligible-for-reviewed-repair"
  | "blocked-policy-drift"
  | "blocked-approval"
  | "blocked-evidence"
  | "manual-review";

export interface LearningRecoveryAssessment {
  skillId: string;
  issueKinds: LearningReconciliationIssue["kind"][];
  disposition: LearningRecoveryDisposition;
  reason: string;
  learningPolicyRevision?: string;
  currentPolicyRevision: string;
}

export interface LearningRecoveryInspection {
  report: LearningReconciliationReport;
  assessments: LearningRecoveryAssessment[];
  currentPolicyRevision: string;
  /** Inspection never mutates either store and never authorizes execution by itself. */
  readOnly: true;
}

export interface LearningRecoveryCoordinatorHost {
  /** Must resolve the authenticated scope; do not accept a model-supplied scope. */
  listActiveLearningSkills(scope: LearningScope): Promise<ActiveLearningSkill[]>;
  /** Must return runtime state from the authoritative lifecycle/runtime registry. */
  listRuntimeSkills(scope: LearningScope): Promise<RuntimeLearningSkill[]>;
  currentPolicyRevision(scope: LearningScope): Promise<string>;
  /** Must resolve a persisted human/operator approval for this exact skill and revision. */
  isExplicitlyApproved(scope: LearningScope, skillId: string, policyRevision: string): Promise<boolean>;
  /** Must re-resolve trusted persisted evidence, not candidate/model-provided evidence. */
  hasTrustedEvidence(scope: LearningScope, skill: ActiveLearningSkill): Promise<boolean>;
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

/**
 * Coordinates authoritative, read-only inspection across the learning store,
 * runtime registry, policy service, approval service, and evidence resolver.
 * It intentionally does not call the repair executor. Callers must present a
 * separately approved plan to the audited executor, which revalidates everything.
 */
export async function inspectLearningRecovery(
  scope: LearningScope,
  host: LearningRecoveryCoordinatorHost,
): Promise<LearningRecoveryInspection> {
  if (!scope || ![scope.tenantId, scope.principalId, scope.projectId].every(value =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 200)) {
    throw new Error("Invalid authenticated learning scope");
  }
  if (!host || typeof host.listActiveLearningSkills !== "function" ||
      typeof host.listRuntimeSkills !== "function" || typeof host.currentPolicyRevision !== "function" ||
      typeof host.isExplicitlyApproved !== "function" || typeof host.hasTrustedEvidence !== "function") {
    throw new Error("Incomplete learning recovery coordinator host");
  }

  const [learningSkills, runtimeSkills, currentPolicyRevision] = await Promise.all([
    host.listActiveLearningSkills({ ...scope }),
    host.listRuntimeSkills({ ...scope }),
    host.currentPolicyRevision({ ...scope }),
  ]);
  if (!validRevision(currentPolicyRevision)) throw new Error("Authoritative policy service returned an invalid revision");

  const report = reconcileLearningActivationState(scope, learningSkills, runtimeSkills);
  const issuesBySkill = new Map<string, LearningReconciliationIssue[]>();
  for (const issue of report.issues) {
    const issues = issuesBySkill.get(issue.skillId) ?? [];
    issues.push(issue);
    issuesBySkill.set(issue.skillId, issues);
  }

  const learningById = new Map<string, ActiveLearningSkill>();
  for (const skill of learningSkills) if (!learningById.has(skill.id)) learningById.set(skill.id, skill);

  const assessments: LearningRecoveryAssessment[] = [];
  for (const [skillId, issues] of issuesBySkill) {
    const kinds = issues.map(issue => issue.kind);
    const skill = learningById.get(skillId);
    if (kinds.length !== 1 || kinds[0] !== "missing-runtime-registration" || !skill) {
      assessments.push({
        skillId, issueKinds: kinds, disposition: "manual-review",
        reason: "Duplicate, runtime-only, policy-mismatch, or conflicting state requires manual reconciliation",
        ...(skill ? { learningPolicyRevision: skill.policyRevision } : {}),
        currentPolicyRevision,
      });
      continue;
    }
    if (skill.policyRevision !== currentPolicyRevision) {
      assessments.push({
        skillId, issueKinds: kinds, disposition: "blocked-policy-drift",
        reason: "Persisted learning policy revision differs from current authoritative policy",
        learningPolicyRevision: skill.policyRevision, currentPolicyRevision,
      });
      continue;
    }
    // Resolve independent gates sequentially so an approval/evidence failure does
    // not cause a later external lookup to be mistaken for an authorization.
    const approved = await host.isExplicitlyApproved({ ...scope }, skillId, currentPolicyRevision);
    if (approved !== true) {
      assessments.push({
        skillId, issueKinds: kinds, disposition: "blocked-approval",
        reason: "No current explicit operator approval for this skill and policy revision",
        learningPolicyRevision: skill.policyRevision, currentPolicyRevision,
      });
      continue;
    }
    const evidenceValid = await host.hasTrustedEvidence({ ...scope }, skill);
    if (evidenceValid !== true) {
      assessments.push({
        skillId, issueKinds: kinds, disposition: "blocked-evidence",
        reason: "Trusted persisted evidence could not be revalidated",
        learningPolicyRevision: skill.policyRevision, currentPolicyRevision,
      });
      continue;
    }
    assessments.push({
      skillId, issueKinds: kinds, disposition: "eligible-for-reviewed-repair",
      reason: "Read-only gates passed; a separate explicit repair plan and executor revalidation are still required",
      learningPolicyRevision: skill.policyRevision, currentPolicyRevision,
    });
  }

  return { report, assessments, currentPolicyRevision, readOnly: true };
}
