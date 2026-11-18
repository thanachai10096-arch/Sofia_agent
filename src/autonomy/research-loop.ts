import {
  defaultAutonomyProfile,
  evaluateAutonomyRequest,
  type AutonomyContext,
  type AutonomyProfile,
} from "./controller.js";

export interface ResearchObservation {
  signal: string;
  sourceIds: string[];
}
export interface ResearchFinding {
  summary: string;
  sourceIds: string[];
  confidence: number;
}
export interface ResearchHypothesis {
  statement: string;
  successMetric: string;
}
export interface ExperimentEvidence {
  passed: boolean;
  summary: string;
  benchmarkBefore: number;
  benchmarkAfter: number;
  safetyIncidents: number;
  artifactVersion?: string;
  rollbackAvailable: boolean;
}
export interface ResearchLoopAdapters {
  observe(signal: AbortSignal): Promise<ResearchObservation>;
  identifyGaps(observation: ResearchObservation, signal: AbortSignal): Promise<string[]>;
  researchLocally(question: string, signal: AbortSignal): Promise<ResearchFinding>;
  formulateHypothesis(question: string, finding: ResearchFinding, signal: AbortSignal): Promise<ResearchHypothesis>;
  /** Must execute only in an OS/container-isolated workspace. */
  experiment(hypothesis: ResearchHypothesis, signal: AbortSignal): Promise<ExperimentEvidence>;
  /** Persist a bounded learning note; implementations must scope by principal. */
  recordLearning(input: {
    principalId: string;
    idempotencyKey: string;
    question: string;
    finding: ResearchFinding;
    hypothesis: ResearchHypothesis;
    evidence?: ExperimentEvidence;
    experimentSkippedReason?: string;
  }, signal: AbortSignal): Promise<void>;
}
export interface ResearchLoopOptions {
  profile?: AutonomyProfile;
  adapters: ResearchLoopAdapters;
  signal: AbortSignal;
  principalId: string;
  /** Trusted runtime attestation, not a model-generated claim. */
  sandboxAvailable: boolean;
  /** Live budget counters from the trusted job/runtime supervisor. */
  budgetContext: () => AutonomyContext;
  maxCycles?: number;
  /** Stable job-scoped namespace prevents unrelated jobs for one principal colliding. */
  idempotencyPrefix?: string;
  startCycle?: number;
  previousCycles?: ResearchCycleResult[];
  onCycle?: (cycle: ResearchCycleResult, nextCycle: number) => Promise<void> | void;
}
export interface ResearchCycleResult {
  cycle: number;
  question: string;
  finding: ResearchFinding;
  hypothesis: ResearchHypothesis;
  evidence?: ExperimentEvidence;
  status: "learned" | "experiment-denied" | "no-gap";
  reason?: string;
}
export interface ResearchLoopReport {
  completed: boolean;
  stoppedBy: "cycle-budget" | "no-knowledge-gap" | "aborted";
  cycles: ResearchCycleResult[];
}

/**
 * Bounded, resumable-by-caller research loop. This module never grants tools:
 * adapters are trusted host dependencies and must continue enforcing
 * ExecutionPolicy, principal isolation, audit and cancellation.
 */
export async function runIndependentResearchLoop(
  options: ResearchLoopOptions,
): Promise<ResearchLoopReport> {
  const profile = options.profile ?? defaultAutonomyProfile;
  const maxCycles = options.maxCycles ?? profile.budget.maxCycles;
  if (!Number.isSafeInteger(maxCycles) || maxCycles < 1 || maxCycles > profile.budget.maxCycles) {
    throw new Error("Research loop cycle limit is invalid or exceeds the autonomy profile.");
  }
  if (!options.principalId.trim()) throw new Error("A principal identity is required for autonomous learning.");

  const idempotencyPrefix = options.idempotencyPrefix?.trim() || `research:${options.principalId}`;
  if (idempotencyPrefix.length > 200) throw new Error("Research idempotency prefix is too long.");
  const startCycle = options.startCycle ?? 1;
  if (!Number.isSafeInteger(startCycle) || startCycle < 1 || startCycle > maxCycles + 1) {
    throw new Error("Research resume cycle is invalid.");
  }
  const cycles: ResearchCycleResult[] = [...(options.previousCycles ?? [])];
  if (cycles.length !== startCycle - 1 || cycles.some((item, index) => item.cycle !== index + 1)) {
    throw new Error("Research checkpoint history does not match the resume cycle.");
  }
  for (let cycle = startCycle; cycle <= maxCycles; cycle += 1) {
    if (options.signal.aborted) {
      return { completed: false, stoppedBy: "aborted", cycles };
    }
    const observation = await options.adapters.observe(options.signal);
    options.signal.throwIfAborted();
    const gapDecision = evaluateAutonomyRequest("research_local", profile);
    if (!gapDecision.allowed) {
      return { completed: false, stoppedBy: "no-knowledge-gap", cycles };
    }
    const gaps = await options.adapters.identifyGaps(observation, options.signal);
    options.signal.throwIfAborted();
    const question = gaps.find((item) => typeof item === "string" && item.trim().length > 0)?.trim();
    if (!question) return { completed: true, stoppedBy: "no-knowledge-gap", cycles };

    const finding = await options.adapters.researchLocally(question.slice(0, 1000), options.signal);
    options.signal.throwIfAborted();
    if (!finding.summary.trim() || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
      throw new Error("Research adapter returned invalid finding evidence.");
    }
    const hypothesis = await options.adapters.formulateHypothesis(question, finding, options.signal);
    options.signal.throwIfAborted();
    if (!hypothesis.statement.trim() || !hypothesis.successMetric.trim()) {
      throw new Error("Research adapter returned an invalid hypothesis.");
    }

    const experimentDecision = evaluateAutonomyRequest("run_experiment", profile, {
      ...options.budgetContext(),
      sandboxAvailable: options.sandboxAvailable,
    });
    if (!experimentDecision.allowed) {
      // Learning from authorized research is still useful; no experiment is run
      // when the sandbox or complete budget attestation is unavailable.
      options.signal.throwIfAborted();
      await options.adapters.recordLearning({
        principalId: options.principalId,
        idempotencyKey: `${idempotencyPrefix}:${cycle}`,
        question, finding, hypothesis,
        experimentSkippedReason: experimentDecision.reason,
      }, options.signal);
      const result: ResearchCycleResult = {
        cycle, question, finding, hypothesis, status: "experiment-denied", reason: experimentDecision.reason,
      };
      cycles.push(result);
      await options.onCycle?.(result, cycle + 1);
      continue;
    }

    const evidence = await options.adapters.experiment(hypothesis, options.signal);
    options.signal.throwIfAborted();
    if (!Number.isFinite(evidence.benchmarkBefore) || !Number.isFinite(evidence.benchmarkAfter) ||
        evidence.safetyIncidents < 0 || !Number.isSafeInteger(evidence.safetyIncidents)) {
      throw new Error("Experiment adapter returned invalid benchmark or safety evidence.");
    }
    options.signal.throwIfAborted();
    await options.adapters.recordLearning({
      principalId: options.principalId,
      idempotencyKey: `${idempotencyPrefix}:${cycle}`,
      question, finding, hypothesis, evidence,
    }, options.signal);
    const result: ResearchCycleResult = { cycle, question, finding, hypothesis, evidence, status: "learned" };
    cycles.push(result);
    await options.onCycle?.(result, cycle + 1);
  }
  return { completed: true, stoppedBy: "cycle-budget", cycles };
}
