/**
 * Sofia Autonomy Controller.
 * Cognitive work is independent from execution authority. This module may
 * authorize learning and isolated experiments, never production side effects.
 */
export type AutonomyAction =
  | "think" | "plan" | "read_memory" | "write_memory"
  | "research_local" | "research_network" | "create_skill_candidate"
  | "run_experiment" | "edit_sandbox" | "promote_skill"
  | "deploy_production" | "external_side_effect" | "change_security_policy"
  | "read_secret" | "destructive_production";

export interface AutonomyBudget {
  maxCycles: number;
  maxSteps: number;
  maxToolCallsPerStep: number;
  maxExperimentSeconds: number;
  maxSpendUsd: number;
}
export interface AutonomyProfile {
  independentThinking: boolean;
  continuousLearning: boolean;
  networkResearch: boolean;
  skillCandidateCreation: boolean;
  sandboxExperiments: boolean;
  budget: AutonomyBudget;
}
export interface AutonomyContext {
  sandboxAvailable?: boolean;
  networkAllowedByExecutionPolicy?: boolean;
  remainingCycles?: number;
  remainingSteps?: number;
  remainingToolCalls?: number;
  experimentSeconds?: number;
  estimatedSpendUsd?: number;
}
export interface SkillPromotionEvidence {
  testsPassed: boolean;
  adversarialTestsPassed: boolean;
  benchmarkScore: number;
  safetyIncidents: number;
  versionedArtifact: boolean;
  rollbackAvailable: boolean;
}
export type AutonomyDecision =
  | { allowed: true; mode: "autonomous" | "sandbox" | "evidence-gated"; reason: string }
  | { allowed: false; mode: "approval-required" | "denied"; reason: string };

export const defaultAutonomyProfile: AutonomyProfile = {
  independentThinking: true,
  continuousLearning: true,
  networkResearch: false,
  skillCandidateCreation: true,
  sandboxExperiments: true,
  budget: { maxCycles: 8, maxSteps: 40, maxToolCallsPerStep: 8, maxExperimentSeconds: 300, maxSpendUsd: 1 },
};

const approvalRequired = new Set<AutonomyAction>([
  "deploy_production", "external_side_effect", "change_security_policy",
  "read_secret", "destructive_production",
]);

export function evaluateAutonomyRequest(
  action: AutonomyAction,
  profile: AutonomyProfile = defaultAutonomyProfile,
  context: AutonomyContext = {},
): AutonomyDecision {
  if (typeof action !== "string" || ![
    "think", "plan", "read_memory", "write_memory", "research_local", "research_network",
    "create_skill_candidate", "run_experiment", "edit_sandbox", "promote_skill",
    "deploy_production", "external_side_effect", "change_security_policy", "read_secret",
    "destructive_production",
  ].includes(action)) {
    return { allowed: false, mode: "denied", reason: "Unknown autonomy action; default deny." };
  }
  if (!profile || typeof profile !== "object" ||
      typeof profile.independentThinking !== "boolean" ||
      typeof profile.continuousLearning !== "boolean" ||
      typeof profile.networkResearch !== "boolean" ||
      typeof profile.skillCandidateCreation !== "boolean" ||
      typeof profile.sandboxExperiments !== "boolean") {
    return { allowed: false, mode: "denied", reason: "Autonomy profile is missing or malformed; default deny." };
  }
  if (approvalRequired.has(action)) {
    return { allowed: false, mode: "approval-required", reason: "This action remains under explicit human approval and cannot be enabled by an autonomy profile." };
  }
  if (action === "research_network") {
    if (!profile.continuousLearning || !profile.networkResearch) {
      return { allowed: false, mode: "denied", reason: "Network research is disabled in the autonomy profile." };
    }
    if (!context.networkAllowedByExecutionPolicy) {
      return { allowed: false, mode: "denied", reason: "The execution policy has not authorized network access or its host allowlist." };
    }
    return { allowed: true, mode: "autonomous", reason: "Both autonomy and execution policies allow network research." };
  }
  if (action === "think" || action === "plan" || action === "read_memory" || action === "research_local") {
    if (!profile.independentThinking && (action === "think" || action === "plan")) {
      return { allowed: false, mode: "denied", reason: "Independent thinking is disabled." };
    }
    if (!profile.continuousLearning && (action === "read_memory" || action === "research_local")) {
      return { allowed: false, mode: "denied", reason: "Continuous learning is disabled." };
    }
    return { allowed: true, mode: "autonomous", reason: "Cognitive work is permitted without granting execution privileges." };
  }
  if (action === "write_memory" || action === "create_skill_candidate") {
    if (!profile.continuousLearning || (action === "create_skill_candidate" && !profile.skillCandidateCreation)) {
      return { allowed: false, mode: "denied", reason: "Learning or skill-candidate creation is disabled." };
    }
    return { allowed: true, mode: "autonomous", reason: "Knowledge and skill candidates may be created; candidates remain untrusted until evaluated." };
  }
  if (action === "run_experiment" || action === "edit_sandbox") {
    if (!profile.sandboxExperiments) return { allowed: false, mode: "denied", reason: "Sandbox experiments are disabled." };
    if (!context.sandboxAvailable) return { allowed: false, mode: "denied", reason: "An isolated sandbox is required; no fallback to host or production is allowed." };
    const budget = profile.budget;
    const validLimit = (value: number, minimum: number, maximum: number): boolean =>
      Number.isSafeInteger(value) && value >= minimum && value <= maximum;
    if (!budget || !validLimit(budget.maxCycles, 1, 10_000) ||
        !validLimit(budget.maxSteps, 1, 100_000) ||
        !validLimit(budget.maxToolCallsPerStep, 1, 10_000) ||
        !validLimit(budget.maxExperimentSeconds, 1, 86_400) ||
        !Number.isFinite(budget.maxSpendUsd) || budget.maxSpendUsd < 0 || budget.maxSpendUsd > 1_000_000) {
      return { allowed: false, mode: "denied", reason: "Autonomy resource budget is invalid; sandbox execution is denied." };
    }
    // A sandbox grant is meaningful only when every resource dimension has
    // been measured. Missing, malformed or negative counters must never mean
    // "unlimited".
    if (!validLimit(context.remainingCycles ?? Number.NaN, 1, budget.maxCycles)) {
      return { allowed: false, mode: "denied", reason: "Autonomy cycle budget is missing, exhausted or exceeds the configured limit." };
    }
    if (!validLimit(context.remainingSteps ?? Number.NaN, 0, budget.maxSteps)) {
      return { allowed: false, mode: "denied", reason: "Requested steps are missing, invalid or exceed the autonomy budget." };
    }
    if (!validLimit(context.remainingToolCalls ?? Number.NaN, 0, budget.maxToolCallsPerStep)) {
      return { allowed: false, mode: "denied", reason: "Requested tool calls are missing, invalid or exceed the per-step budget." };
    }
    if (!validLimit(context.experimentSeconds ?? Number.NaN, 0, budget.maxExperimentSeconds)) {
      return { allowed: false, mode: "denied", reason: "Experiment runtime is missing, invalid or exceeds the configured budget." };
    }
    if (!Number.isFinite(context.estimatedSpendUsd) || (context.estimatedSpendUsd ?? -1) < 0 ||
        (context.estimatedSpendUsd ?? Number.POSITIVE_INFINITY) > budget.maxSpendUsd) {
      return { allowed: false, mode: "denied", reason: "Estimated spend is missing, invalid or exceeds the configured budget." };
    }
    return { allowed: true, mode: "sandbox", reason: "Experiment is isolated and every resource dimension is within its configured budget." };
  }
  return { allowed: false, mode: "denied", reason: "Unknown autonomy action; default deny." };
}

/** Eligibility only; this function never mutates the skill registry or deploys. */
export function evaluateSkillPromotion(evidence: SkillPromotionEvidence): AutonomyDecision {
  if (!evidence || typeof evidence !== "object") {
    return { allowed: false, mode: "denied", reason: "Promotion evidence is missing or malformed." };
  }
  const validScore = typeof evidence.benchmarkScore === "number" &&
    Number.isFinite(evidence.benchmarkScore) && evidence.benchmarkScore >= 0.9 && evidence.benchmarkScore <= 1;
  const validEvidence = typeof evidence.testsPassed === "boolean" &&
    typeof evidence.adversarialTestsPassed === "boolean" &&
    Number.isSafeInteger(evidence.safetyIncidents) && evidence.safetyIncidents >= 0 &&
    typeof evidence.versionedArtifact === "boolean" &&
    typeof evidence.rollbackAvailable === "boolean";
  if (!validEvidence || !evidence.testsPassed || !evidence.adversarialTestsPassed || !validScore ||
      evidence.safetyIncidents !== 0 || !evidence.versionedArtifact || !evidence.rollbackAvailable) {
    return { allowed: false, mode: "denied", reason: "Requires passing tests and adversarial tests, benchmark >= 0.90, zero safety incidents, a versioned artifact and rollback." };
  }
  return { allowed: true, mode: "evidence-gated", reason: "Evidence threshold met. Controlled registry promotion may proceed; production deployment is not authorized." };
}
