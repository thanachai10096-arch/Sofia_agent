import type { SettlementRunInspection } from "./settlement-journal.js";

/**
 * A conservative, side-effect-free interpretation of settlement evidence.
 *
 * "eligible_for_claim_recheck" is deliberately not permission to replay a run.
 * Callers must acquire the real per-run claim and inspect again while holding
 * that claim before admitting any provider work.
 */
export type SettlementRecoveryDecision =
  | {
      decision: "hold_active_claim";
      requiresOperator: true;
      reasons: readonly ["claim_active"];
      nextStep: "isolate_workers_and_verify_owner";
    }
  | {
      decision: "operator_reconciliation_required";
      requiresOperator: true;
      reasons: readonly string[];
      nextStep: "preserve_evidence_and_reconcile_provider_usage";
    }
  | {
      decision: "eligible_for_claim_recheck";
      requiresOperator: false;
      reasons: readonly ["no_blocking_evidence_observed"];
      nextStep: "acquire_claim_then_reinspect";
    };

/**
 * Classifies a read-only inspection snapshot. It never changes journal or
 * claim state, and it never authorizes replay by itself.
 */
export function decideSettlementRecovery(
  inspection: SettlementRunInspection,
): SettlementRecoveryDecision {
  if (inspection.claim === "active") {
    return {
      decision: "hold_active_claim",
      requiresOperator: true,
      reasons: ["claim_active"],
      nextStep: "isolate_workers_and_verify_owner",
    };
  }

  const reasons: string[] = [];
  const counts = [
    inspection.startedAttempts,
    inspection.settledAttempts,
    inspection.unknownUsageAttempts,
    inspection.checkpoints,
  ];
  const countsValid = counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    inspection.settledAttempts <= inspection.startedAttempts &&
    inspection.unknownUsageAttempts <= inspection.settledAttempts &&
    (inspection.journal !== "missing" || counts.every((count) => count === 0));
  if (!countsValid) reasons.push("inspection_counts_invalid");
  if (inspection.unknownUsageAttempts > 0) reasons.push("unknown_usage_reported");
  if (inspection.claim === "invalid") reasons.push("claim_invalid");
  if (inspection.journal === "corrupt") reasons.push("journal_corrupt");
  if (inspection.journal === "unresolved" || inspection.unresolved) {
    reasons.push("settlement_evidence_unresolved");
  }
  if (inspection.journal !== "missing" &&
      inspection.journal !== "resolved" &&
      inspection.journal !== "corrupt" &&
      inspection.journal !== "unresolved") {
    reasons.push("journal_state_unknown");
  }
  if (inspection.claim !== "absent" && inspection.claim !== "invalid") {
    reasons.push("claim_state_unknown");
  }

  if (reasons.length > 0) {
    return {
      decision: "operator_reconciliation_required",
      requiresOperator: true,
      reasons,
      nextStep: "preserve_evidence_and_reconcile_provider_usage",
    };
  }

  return {
    decision: "eligible_for_claim_recheck",
    requiresOperator: false,
    reasons: ["no_blocking_evidence_observed"],
    nextStep: "acquire_claim_then_reinspect",
  };
}
