/**
 * Stable ports for evidence-gated learning. Adapters must use trusted, persisted
 * Sofia evidence; model output and skill metadata are never verification evidence.
 */
export interface LearningScope {
  tenantId: string;
  principalId: string;
  projectId: string;
}
export interface VerificationReceipt {
  id: string;
  runId: string;
  scope: LearningScope;
  completed: boolean;
  verified: boolean;
  verifier: string;
  evidenceIds: string[];
  policyRevision: string;
  completedAt: string;
}
export interface RunEvidence {
  id: string;
  runId: string;
  scope: LearningScope;
  kind: "tool-result" | "verification" | "regression";
  trusted: boolean;
  success: boolean;
  content: string;
  createdAt: string;
}
export interface LearningExperience {
  id: string;
  scope: LearningScope;
  receiptId: string;
  runId: string;
  evidenceIds: string[];
  summary: string;
  taskFingerprint: string;
  createdAt: string;
}
export interface SkillCandidate {
  id: string;
  scope: LearningScope;
  experienceId: string;
  name: string;
  trigger: string;
  procedure: string[];
  confidence: number;
}
export interface SkillEvaluation {
  regressionRunId: string;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  regressionEvidenceIds: string[];
}
export interface ActiveLearningSkill extends SkillCandidate {
  status: "active";
  activatedAt: string;
  policyRevision: string;
}
export interface LearningTransaction {
  /** Must atomically enforce uniqueness for (scope, receiptId). */
  insertExperienceIfAbsent(experience: LearningExperience): Promise<boolean>;
  listExperiences(scope: LearningScope, limit: number): Promise<LearningExperience[]>;
  getExperience(scope: LearningScope, id: string): Promise<LearningExperience | undefined>;
  /** Recover a previously committed experience when processing was interrupted after receipt deduplication. */
  getExperienceByReceipt(scope: LearningScope, receiptId: string): Promise<LearningExperience | undefined>;
  putCandidate(candidate: SkillCandidate): Promise<void>;
  getCandidate(scope: LearningScope, id: string): Promise<SkillCandidate | undefined>;
  recordEvaluation(scope: LearningScope, candidateId: string, evaluation: SkillEvaluation): Promise<void>;
  activateSkill(skill: ActiveLearningSkill): Promise<void>;
  listActiveSkills(scope: LearningScope): Promise<ActiveLearningSkill[]>;
}
export interface VerifiedLearningHost {
  transaction<T>(scope: LearningScope, operation: (tx: LearningTransaction) => Promise<T>): Promise<T>;
  verification: {
    getReceipt(scope: LearningScope, receiptId: string): Promise<VerificationReceipt | undefined>;
    getEvidence(scope: LearningScope, evidenceIds: string[]): Promise<RunEvidence[]>;
    runRegression(scope: LearningScope, candidate: SkillCandidate): Promise<SkillEvaluation>;
  };
  currentPolicyRevision(scope: LearningScope): Promise<string>;
  redact(text: string): string;
  assessCandidate(scope: LearningScope, candidate: SkillCandidate): Promise<{ allowed: boolean; confidence: number; reason?: string }>;
}
export interface LearningLoopOptions {
  maxEvidenceAgeMs?: number;
  minimumConfidence?: number;
  maxExperienceSummaryChars?: number;
  maxSkillProcedureSteps?: number;
  historyLimit?: number;
}
