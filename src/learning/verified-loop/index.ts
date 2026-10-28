export { VerifiedLearningLoop } from "./loop.js";
export type * from "./ports.js";
export { normalizeText, sameScope, validEvidence, validReceipt, validScope } from "./validation.js";
export { createVerifiedCompletionHandler } from "./brain-adapter.js";
export type { FinalizedBrainCompletion, PersistedCompletionReceipt } from "./brain-adapter.js";
export { ScopedSelfImprovement } from "./self-improvement.js";
export type { SelfImprovementCheckpointStore, VerifiedExecutionNotification } from "./self-improvement.js";
