import type { ActiveLearningSkill, LearningScope } from "./ports.js";

/** Runtime skill identity must be associated with its authenticated owner scope. */
export interface RuntimeLearningSkill {
  id: string;
  scope: LearningScope;
  policyRevision: string;
  active: boolean;
}
export type LearningReconciliationIssue =
  | { kind: "missing-runtime-registration"; skillId: string }
  | { kind: "runtime-active-without-learning-record"; skillId: string }
  | { kind: "policy-revision-mismatch"; skillId: string; learningRevision: string; runtimeRevision: string }
  | { kind: "duplicate-learning-skill-id"; skillId: string }
  | { kind: "duplicate-runtime-skill-id"; skillId: string };
export interface LearningReconciliationReport {
  scope: LearningScope;
  checkedLearningSkills: number;
  checkedRuntimeSkills: number;
  issues: LearningReconciliationIssue[];
  safe: boolean;
}
function validScope(scope: LearningScope): boolean {
  return Boolean(scope && [scope.tenantId, scope.principalId, scope.projectId].every(value => typeof value === "string" && value.trim().length > 0));
}
function sameScope(a: LearningScope, b: LearningScope): boolean {
  return a.tenantId === b.tenantId && a.principalId === b.principalId && a.projectId === b.projectId;
}

/**
 * Read-only cross-store consistency check. It deliberately does not mutate either
 * store or auto-register/unregister skills. Repair must be a separate audited action
 * after verifying the authoritative runtime scope mapping.
 */
export function reconcileLearningActivationState(
  scope: LearningScope,
  learningSkills: ActiveLearningSkill[],
  runtimeSkills: RuntimeLearningSkill[],
): LearningReconciliationReport {
  if (!validScope(scope)) throw new Error("Invalid authenticated learning scope");
  if (!Array.isArray(learningSkills) || !Array.isArray(runtimeSkills)) throw new Error("Reconciliation inputs must be arrays");
  const issues: LearningReconciliationIssue[] = [];
  const learningById = new Map<string, ActiveLearningSkill>();
  for (const skill of learningSkills) {
    if (!skill || !validScope(skill.scope) || !sameScope(skill.scope, scope)) throw new Error("Cross-scope learning skill in reconciliation input");
    if (typeof skill.id !== "string" || !skill.id.trim() || typeof skill.policyRevision !== "string" || !skill.policyRevision.trim()) throw new Error("Invalid persisted learning activation record");
    if (learningById.has(skill.id)) issues.push({ kind: "duplicate-learning-skill-id", skillId: skill.id });
    else learningById.set(skill.id, skill);
  }
  const runtimeById = new Map<string, RuntimeLearningSkill>();
  for (const skill of runtimeSkills) {
    if (!skill || !validScope(skill.scope) || !sameScope(skill.scope, scope)) throw new Error("Cross-scope runtime skill in reconciliation input");
    if (typeof skill.id !== "string" || !skill.id.trim() || typeof skill.policyRevision !== "string" || !skill.policyRevision.trim() || typeof skill.active !== "boolean") throw new Error("Invalid runtime activation record");
    if (runtimeById.has(skill.id)) issues.push({ kind: "duplicate-runtime-skill-id", skillId: skill.id });
    else runtimeById.set(skill.id, skill);
  }
  for (const [id, learning] of learningById) {
    const runtime = runtimeById.get(id);
    if (!runtime || !runtime.active) issues.push({ kind: "missing-runtime-registration", skillId: id });
    else if (runtime.policyRevision !== learning.policyRevision) issues.push({ kind: "policy-revision-mismatch", skillId: id, learningRevision: learning.policyRevision, runtimeRevision: runtime.policyRevision });
  }
  for (const [id, runtime] of runtimeById) {
    if (runtime.active && !learningById.has(id)) issues.push({ kind: "runtime-active-without-learning-record", skillId: id });
  }
  return { scope: { ...scope }, checkedLearningSkills: learningSkills.length, checkedRuntimeSkills: runtimeSkills.length, issues, safe: issues.length === 0 };
}
