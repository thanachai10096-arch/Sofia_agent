import type { ActiveLearningSkill, LearningScope } from "./ports.js";
import {
  reconcileLearningActivationState,
  type LearningReconciliationIssue,
  type LearningReconciliationReport,
  type RuntimeLearningSkill,
} from "./reconciliation.js";

export type LearningRecoveryDisposition =
  | "eligible-for-reviewed-repair"
  | "blocked-policy-drift"
  | "blocked-approval"
  | "blocked-evidence"
  | "manual-review";

export interface LearningRecoveryApprovalBinding {
  id: string;
  actorId: string;
  skillId: string;
  scope: LearningScope;
  policyRevision: string;
  status: "approved";
}

export interface LearningRecoveryAssessment {
  skillId: string;
  issueKinds: LearningReconciliationIssue["kind"][];
  disposition: LearningRecoveryDisposition;
  reason: string;
  learningPolicyRevision?: string;
  currentPolicyRevision: string;
  approvalBinding?: LearningRecoveryApprovalBinding;
}

export interface LearningRecoveryInspection {
  report: LearningReconciliationReport;
  assessments: LearningRecoveryAssessment[];
  currentPolicyRevision: string;
  /** Inspection never mutates either store and never authorizes execution by itself. */
  readOnly: true;
}

/**
 * Converts only coordinator-approved assessments into the planner's authorization
 * shape. This is a convenience bridge, not a new authorization source: the
 * executor must still resolve the receipt and revalidate actor, scope, policy,
 * evidence, and runtime state immediately before mutation.
 *
 * Returns undefined when no assessment passed every coordinator gate.
 */
export function createLearningRepairAuthorizationFromRecovery(
  inspection: LearningRecoveryInspection,
  idempotencyKey: string,
): import("./reconciliation-repair.js").LearningRepairAuthorization | undefined {
  if (!inspection || inspection.readOnly !== true ||
      !inspection.report || !inspection.report.scope ||
      !validRevision(inspection.currentPolicyRevision) ||
      typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200 ||
      !Array.isArray(inspection.assessments)) {
    throw new Error("Invalid learning recovery inspection");
  }
  const scope = inspection.report.scope;
  if (![scope.tenantId, scope.principalId, scope.projectId].every(value =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 200)) {
    throw new Error("Invalid learning recovery inspection scope");
  }
  const eligible = inspection.assessments.filter(item => item.disposition === "eligible-for-reviewed-repair");
  if (eligible.length === 0) return undefined;

  const actorId = eligible[0]?.approvalBinding?.actorId;
  if (typeof actorId !== "string" || !actorId.trim() || actorId.length > 200) {
    throw new Error("Eligible recovery assessment is missing an authenticated approval binding");
  }
  const approvedSkillIds: string[] = [];
  const approvalIds: Record<string, string> = Object.create(null) as Record<string, string>;
  const learningPolicyRevisions: Record<string, string> = Object.create(null) as Record<string, string>;
  const currentPolicyRevisions: Record<string, string> = Object.create(null) as Record<string, string>;
  const trustedEvidenceSkillIds: string[] = [];

  for (const assessment of eligible) {
    const binding = assessment.approvalBinding;
    if (!binding || binding.status !== "approved" || binding.actorId !== actorId ||
        binding.skillId !== assessment.skillId || !validRevision(binding.id) ||
        binding.policyRevision !== inspection.currentPolicyRevision ||
        assessment.currentPolicyRevision !== inspection.currentPolicyRevision ||
        assessment.learningPolicyRevision !== inspection.currentPolicyRevision ||
        !binding.scope || binding.scope.tenantId !== scope.tenantId ||
        binding.scope.principalId !== scope.principalId || binding.scope.projectId !== scope.projectId) {
      throw new Error("Eligible recovery assessment has an invalid approval binding");
    }
    if (Object.prototype.hasOwnProperty.call(approvalIds, assessment.skillId)) {
      throw new Error("Duplicate eligible recovery skill");
    }
    approvedSkillIds.push(assessment.skillId);
    approvalIds[assessment.skillId] = binding.id;
    learningPolicyRevisions[assessment.skillId] = assessment.learningPolicyRevision;
    currentPolicyRevisions[assessment.skillId] = assessment.currentPolicyRevision;
    trustedEvidenceSkillIds.push(assessment.skillId);
  }

  return {
    scope: { ...scope },
    actorId,
    idempotencyKey,
    approvedSkillIds,
    approvalIds,
    learningPolicyRevisions,
    currentPolicyRevisions,
    trustedEvidenceSkillIds,
  };
}

export interface LearningRecoveryCoordinatorHost {
  /** Must resolve the authenticated scope; do not accept a model-supplied scope. */
  listActiveLearningSkills(scope: LearningScope): Promise<ActiveLearningSkill[]>;
  /** Must return runtime state from the authoritative lifecycle/runtime registry. */
  listRuntimeSkills(scope: LearningScope): Promise<RuntimeLearningSkill[]>;
  currentPolicyRevision(scope: LearningScope): Promise<string>;
  /** Must resolve the authenticated operator identity from trusted host context, never model/user-supplied task data. */
  authenticatedActorId(scope: LearningScope): Promise<string | undefined>;
  /** Must resolve a persisted human/operator approval for this exact skill and revision. */
  isExplicitlyApproved(scope: LearningScope, skillId: string, policyRevision: string): Promise<boolean>;
  resolveApprovalBinding?(scope: LearningScope, skillId: string, policyRevision: string): Promise<LearningRecoveryApprovalBinding | undefined>;
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
      typeof host.authenticatedActorId !== "function" ||
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
    const matchingRuntimeEntries = runtimeSkills.filter(runtime => runtime.id === skillId);
    // Reconciliation uses the same issue kind for an absent registration and an
    // existing inactive entry. Only a truly absent entry is eligible for review;
    // an inactive runtime object may encode a deliberate disable/revocation.
    if (kinds.length !== 1 || kinds[0] !== "missing-runtime-registration" || !skill || matchingRuntimeEntries.length > 0) {
      assessments.push({
        skillId, issueKinds: kinds, disposition: "manual-review",
        reason: matchingRuntimeEntries.length > 0
          ? "An inactive or otherwise existing runtime entry requires manual reconciliation; do not reactivate it automatically"
          : "Duplicate, runtime-only, policy-mismatch, or conflicting state requires manual reconciliation",
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
    if (typeof host.resolveApprovalBinding !== "function") {
      assessments.push({ skillId, issueKinds: kinds, disposition: "blocked-approval",
        reason: "Approval service did not provide a persisted receipt bound to the authenticated actor, skill, scope, and policy revision",
        learningPolicyRevision: skill.policyRevision, currentPolicyRevision });
      continue;
    }
    const authenticatedActorId = await host.authenticatedActorId({ ...scope });
    if (typeof authenticatedActorId !== "string" || !authenticatedActorId.trim() || authenticatedActorId.length > 200) {
      assessments.push({ skillId, issueKinds: kinds, disposition: "blocked-approval",
        reason: "Authenticated operator identity is unavailable; approval receipt cannot be actor-bound",
        learningPolicyRevision: skill.policyRevision, currentPolicyRevision });
      continue;
    }
    const approvalBinding = await host.resolveApprovalBinding({ ...scope }, skillId, currentPolicyRevision);
    if (!approvalBinding || typeof approvalBinding.id !== "string" || !approvalBinding.id.trim() ||
        typeof approvalBinding.actorId !== "string" || !approvalBinding.actorId.trim() ||
        approvalBinding.actorId !== authenticatedActorId ||
        approvalBinding.skillId !== skillId || approvalBinding.status !== "approved" ||
        approvalBinding.policyRevision !== currentPolicyRevision ||
        !approvalBinding.scope || approvalBinding.scope.tenantId !== scope.tenantId ||
        approvalBinding.scope.principalId !== scope.principalId || approvalBinding.scope.projectId !== scope.projectId) {
      assessments.push({ skillId, issueKinds: kinds, disposition: "blocked-approval",
        reason: "Persisted approval receipt is missing, revoked, or bound to a different actor, skill, scope, or policy revision",
        learningPolicyRevision: skill.policyRevision, currentPolicyRevision });
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
    // Approval and evidence resolution may take time. Re-read policy after both
    // gates so this advisory assessment never reports eligibility on a known stale revision.
    const finalPolicyRevision = await host.currentPolicyRevision({ ...scope });
    if (!validRevision(finalPolicyRevision)) throw new Error("Authoritative policy service returned an invalid revision");
    if (finalPolicyRevision !== currentPolicyRevision) {
      assessments.push({
        skillId, issueKinds: kinds, disposition: "blocked-policy-drift",
        reason: "Authoritative policy revision changed while approval and evidence were being revalidated",
        learningPolicyRevision: skill.policyRevision, currentPolicyRevision: finalPolicyRevision,
      });
      continue;
    }
    assessments.push({
      skillId, issueKinds: kinds, disposition: "eligible-for-reviewed-repair",
      reason: "Read-only gates passed; a separate explicit repair plan and executor revalidation are still required",
      learningPolicyRevision: skill.policyRevision, currentPolicyRevision, approvalBinding,
    });
  }

  return { report, assessments, currentPolicyRevision, readOnly: true };
}
