import type { AcceptanceCriterion } from "./types.js";
import type { BrainRunSnapshot } from "./run-state.js";

export type AcceptanceEvaluator = (data: unknown) => { passed: boolean; detail: string };

const evaluators = new Map<string, AcceptanceEvaluator>();

export function registerAcceptanceEvaluator(id: string, evaluator: AcceptanceEvaluator): () => void {
  const normalized = id.trim();
  if (!normalized) throw new Error("Acceptance evaluator ID must not be empty.");
  if (typeof evaluator !== "function") throw new Error("Acceptance evaluator must be a function.");
  const existing = evaluators.get(normalized);
  if (existing && existing !== evaluator) {
    throw new Error("Acceptance evaluator ID is already registered: " + normalized);
  }
  evaluators.set(normalized, evaluator);
  return () => {
    if (evaluators.get(normalized) === evaluator) evaluators.delete(normalized);
  };
}

export function hydrateAcceptanceCriteria(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value)) throw new Error("Run snapshot acceptanceCriteria must be an array.");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Run snapshot contains an invalid acceptance criterion at index " + index + ".");
    }
    const criterion = raw as Partial<AcceptanceCriterion>;
    if (
      typeof criterion.id !== "string" ||
      !criterion.id.trim() ||
      typeof criterion.description !== "string" ||
      !criterion.description.trim() ||
      !criterion.probe ||
      typeof criterion.probe !== "object" ||
      typeof criterion.probe.tool !== "string" ||
      !criterion.probe.tool.trim() ||
      !criterion.probe.input ||
      typeof criterion.probe.input !== "object" ||
      Array.isArray(criterion.probe.input)
    ) {
      throw new Error("Run snapshot contains an invalid acceptance criterion at index " + index + ".");
    }
    if (typeof criterion.evaluate === "function") return criterion as AcceptanceCriterion;
    const evaluatorId = criterion.evaluatorId;
    const evaluator = typeof evaluatorId === "string" ? evaluators.get(evaluatorId) : undefined;
    return {
      ...criterion,
      evaluate: evaluator,
    } as AcceptanceCriterion;
  });
}

export function hydrateBrainRunSnapshot(value: unknown, expectedRunId?: string): BrainRunSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Run snapshot is corrupt: expected an object.");
  }
  const snapshot = value as Partial<BrainRunSnapshot>;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.runId !== "string" ||
    !snapshot.runId ||
    (expectedRunId !== undefined && snapshot.runId !== expectedRunId) ||
    typeof snapshot.task !== "string" ||
    !snapshot.task ||
    typeof snapshot.checkpointId !== "string" ||
    !snapshot.checkpointId ||
    !Array.isArray(snapshot.completedStepIds) ||
    !snapshot.usage ||
    typeof snapshot.usage !== "object" ||
    !Array.isArray(snapshot.observations) ||
    !Array.isArray(snapshot.diagnoses) ||
    !Array.isArray(snapshot.decisions) ||
    !Array.isArray(snapshot.trace)
  ) {
    throw new Error("Run snapshot is corrupt or incompatible with this runtime version.");
  }
  return {
    ...(snapshot as BrainRunSnapshot),
    acceptanceCriteria: hydrateAcceptanceCriteria(snapshot.acceptanceCriteria),
  };
}

export function assertAcceptanceCriteriaResumable(snapshot: BrainRunSnapshot): void {
  const missing = snapshot.acceptanceCriteria
    .filter((criterion) => typeof criterion.evaluate !== "function")
    .map((criterion) => criterion.evaluatorId ?? criterion.id);
  if (missing.length > 0) {
    throw new Error(
      "Cannot resume this checkpoint because acceptance evaluator(s) are not registered: " +
      missing.join(", ") +
      ". Register the same evaluator IDs before resuming this job.",
    );
  }
}
