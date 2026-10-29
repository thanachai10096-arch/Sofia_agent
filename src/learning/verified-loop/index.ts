export { VerifiedLearningLoop } from "./loop.js";
export type * from "./ports.js";
export { normalizeText, sameScope, validEvidence, validReceipt, validScope } from "./validation.js";
export { createVerifiedCompletionHandler } from "./brain-adapter.js";
export type { FinalizedBrainCompletion, PersistedCompletionReceipt } from "./brain-adapter.js";
export { ScopedSelfImprovement } from "./self-improvement.js";
export type { SelfImprovementCheckpointStore, VerifiedExecutionNotification } from "./self-improvement.js";
export { SqliteSelfImprovementCheckpointStore } from "./sqlite-checkpoint-store.js";
export { SqliteLearningTransactionStore, withSqliteLearningTransactions } from "./sqlite-learning-store.js"; 

export { createLearningLifecyclePromoter } from "./lifecycle-promoter.js";
export type { LearningLifecyclePromotionOptions } from "./lifecycle-promoter.js";

export { reconcileLearningActivationState } from "./reconciliation.js";
export type { RuntimeLearningSkill, LearningReconciliationIssue, LearningReconciliationReport } from "./reconciliation.js";

export { planLearningReconciliationRepair } from "./reconciliation-repair.js";
export type { LearningRepairAuthorization, LearningRepairAction, LearningRepairBlock, LearningRepairPlan } from "./reconciliation-repair.js";
