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
    if (context.remainingCycles !== undefined && context.remainingCycles <= 0) return { allowed: false, mode: "denied", reason: "Autonomy cycle budget exhausted." };
    if (context.remainingSteps !== undefined && context.remainingSteps > budget.maxSteps) return { allowed: false, mode: "denied", reason: "Requested steps exceed the autonomy budget." };
    if (context.remainingToolCalls !== undefined && context.remainingToolCalls > budget.maxToolCallsPerStep) return { allowed: false, mode: "denied", reason: "Requested tool calls exceed the per-step budget." };
    if (context.experimentSeconds !== undefined && context.experimentSeconds > budget.maxExperimentSeconds) return { allowed: false, mode: "denied", reason: "Experiment runtime exceeds the configured budget." };
    if (context.estimatedSpendUsd !== undefined && context.estimatedSpendUsd > budget.maxSpendUsd) return { allowed: false, mode: "denied", reason: "Estimated spend exceeds the configured budget." };
    return { allowed: true, mode: "sandbox", reason: "Experiment is isolated and bounded by resource budgets." };
  }
  return { allowed: false, mode: "denied", reason: "Unknown autonomy action; default deny." };
}

/** Eligibility only; this function never mutates the skill registry or deploys. */
export function evaluateSkillPromotion(evidence: SkillPromotionEvidence): AutonomyDecision {
  const validScore = Number.isFinite(evidence.benchmarkScore) && evidence.benchmarkScore >= 0.9 && evidence.benchmarkScore <= 1;
  if (!evidence.testsPassed || !evidence.adversarialTestsPassed || !validScore ||
      evidence.safetyIncidents !== 0 || !evidence.versionedArtifact || !evidence.rollbackAvailable) {
    return { allowed: false, mode: "denied", reason: "Requires passing tests and adversarial tests, benchmark >= 0.90, zero safety incidents, a versioned artifact and rollback." };
  }
  return { allowed: true, mode: "evidence-gated", reason: "Evidence threshold met. Controlled registry promotion may proceed; production deployment is not authorized." };
}
