import type { LearningScope } from "./ports.js";
import type { LearningReconciliationIssue, LearningReconciliationReport } from "./reconciliation.js";

export interface LearningRepairAuthorization {
  scope: LearningScope;
  /** Authenticated operator identity; never accept this from a model-generated candidate. */
  actorId: string;
  /** Caller-provided key persisted by the eventual repair executor for idempotent replay. */
  idempotencyKey: string;
  /** Explicitly approved skill IDs. Approval is scoped to this plan and does not itself execute repair. */
  approvedSkillIds: string[];
  /** Policy revision from the freshly re-read authoritative learning record. */
  learningPolicyRevisions: Record<string, string>;
  /** Current policy revision from the authoritative policy service. */
  currentPolicyRevisions: Record<string, string>;
  /** Skill IDs for which authoritative trusted evidence has been re-resolved. */
  trustedEvidenceSkillIds: string[];
}
export interface LearningRepairAction {
  kind: "register-missing-runtime-skill";
  skillId: string;
  expectedPolicyRevision: string;
  scope: LearningScope;
  actorId: string;
  idempotencyKey: string;
}
export interface LearningRepairBlock {
  skillId: string;
  reason: "not-explicitly-approved" | "policy-revision-stale" | "trusted-evidence-missing" | "conflicting-issues" | "unsupported-issue";
}
export interface LearningRepairPlan {
  planId: string;
  scope: LearningScope;
  actions: LearningRepairAction[];
  blocked: LearningRepairBlock[];
  /** A plan is never proof of execution; a separate audited executor must revalidate state. */
  eligibleForExecutor: boolean;
}
const sameScope = (a: LearningScope, b: LearningScope) =>
  a.tenantId === b.tenantId && a.principalId === b.principalId && a.projectId === b.projectId;
const validText = (value: unknown, max = 500): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const validScope = (scope: LearningScope): boolean => Boolean(scope && [scope.tenantId, scope.principalId, scope.projectId].every(value => validText(value, 200)));

/**
 * Creates a conservative, non-mutating repair plan. Only a missing runtime
 * registration can be proposed, and only with explicit approval, matching current
 * policy revision, and freshly resolved trusted evidence. Any other issue for the
 * same skill blocks repair. The eventual executor must re-read all state and use a
 * durable idempotency journal plus an audit trail; this function performs no I/O.
 */
export function planLearningReconciliationRepair(
  report: LearningReconciliationReport,
  authorization: LearningRepairAuthorization,
): LearningRepairPlan {
  if (!report || !validScope(report.scope) || !validScope(authorization?.scope) || !sameScope(report.scope, authorization.scope)) {
    throw new Error("Invalid reconciliation report scope");
  }
  if (!validText(authorization?.actorId, 200) || !validText(authorization?.idempotencyKey, 200) ||
      !Array.isArray(authorization.approvedSkillIds) ||
      !authorization.approvedSkillIds.every(id => validText(id, 200)) ||
      !Array.isArray(authorization.trustedEvidenceSkillIds) ||
      !authorization.trustedEvidenceSkillIds.every(id => validText(id, 200)) ||
      !authorization.learningPolicyRevisions || typeof authorization.learningPolicyRevisions !== "object" || Array.isArray(authorization.learningPolicyRevisions) ||
      !authorization.currentPolicyRevisions || typeof authorization.currentPolicyRevisions !== "object" || Array.isArray(authorization.currentPolicyRevisions)) {
    throw new Error("Invalid learning repair authorization");
  }
  const scope = report.scope;
  const issues = report.issues;
  if (!Array.isArray(issues) || typeof report.safe !== "boolean" ||
      !Number.isSafeInteger(report.checkedLearningSkills) || report.checkedLearningSkills < 0 ||
      !Number.isSafeInteger(report.checkedRuntimeSkills) || report.checkedRuntimeSkills < 0 ||
      report.safe !== (issues.length === 0)) {
    throw new Error("Invalid reconciliation report");
  }
  const actions: LearningRepairAction[] = [];
  const blocked: LearningRepairBlock[] = [];
  const bySkill = new Map<string, LearningReconciliationIssue[]>();
  for (const issue of issues) {
    if (!issue || !validText(issue.skillId, 200)) throw new Error("Invalid reconciliation issue");
    const bucket = bySkill.get(issue.skillId) ?? [];
    bucket.push(issue);
    bySkill.set(issue.skillId, bucket);
  }
  for (const [skillId, skillIssues] of bySkill) {
    const missing = skillIssues.length === 1 && skillIssues[0]?.kind === "missing-runtime-registration";
    if (!missing) {
      blocked.push({ skillId, reason: skillIssues.some(issue => issue.kind === "missing-runtime-registration") ? "conflicting-issues" : "unsupported-issue" });
      continue;
    }
    if (!authorization.approvedSkillIds.includes(skillId)) {
      blocked.push({ skillId, reason: "not-explicitly-approved" });
      continue;
    }
    const expectedPolicyRevision = authorization.currentPolicyRevisions[skillId];
    const learningPolicyRevision = authorization.learningPolicyRevisions[skillId];
    const learningIssue = skillIssues[0];
    if (!validText(expectedPolicyRevision, 200) || !validText(learningPolicyRevision, 200) || expectedPolicyRevision !== learningPolicyRevision || !learningIssue) {
      blocked.push({ skillId, reason: "policy-revision-stale" });
      continue;
    }
    if (!authorization.trustedEvidenceSkillIds.includes(skillId)) {
      blocked.push({ skillId, reason: "trusted-evidence-missing" });
      continue;
    }
    actions.push({ kind: "register-missing-runtime-skill", skillId, expectedPolicyRevision, scope: { ...scope }, actorId: authorization.actorId, idempotencyKey: authorization.idempotencyKey + ":" + skillId });
  }
  return { planId: authorization.idempotencyKey, scope: { ...scope }, actions, blocked, eligibleForExecutor: actions.length > 0 && blocked.length === 0 };
}
