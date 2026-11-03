import assert from "node:assert/strict";
import test from "node:test";
import { decideSettlementRecovery } from "./settlement-recovery.js";
import type { SettlementRunInspection } from "./settlement-journal.js";

const inspection = (overrides: Partial<SettlementRunInspection> = {}): SettlementRunInspection => ({
  claim: "absent",
  journal: "missing",
  startedAttempts: 0,
  settledAttempts: 0,
  unknownUsageAttempts: 0,
  checkpoints: 0,
  unresolved: false,
  ...overrides,
});

test("recovery decision only recommends a claim recheck for clear evidence", () => {
  assert.deepEqual(decideSettlementRecovery(inspection()), {
    decision: "eligible_for_claim_recheck",
    requiresOperator: false,
    reasons: ["no_blocking_evidence_observed"],
    nextStep: "acquire_claim_then_reinspect",
  });
  assert.equal(
    decideSettlementRecovery(inspection({ journal: "resolved" })).decision,
    "eligible_for_claim_recheck",
  );
});

test("active claims always hold even when journal appears resolved", () => {
  const result = decideSettlementRecovery(inspection({
    claim: "active",
    journal: "resolved",
  }));
  assert.equal(result.decision, "hold_active_claim");
  assert.equal(result.requiresOperator, true);
  assert.deepEqual(result.reasons, ["claim_active"]);
});

test("invalid claims, corrupt journals, and unresolved attempts require operator reconciliation", () => {
  const cases: SettlementRunInspection[] = [
    inspection({ claim: "invalid" }),
    inspection({ journal: "corrupt", unresolved: true }),
    inspection({ journal: "unresolved", unresolved: true }),
    inspection({ journal: "resolved", unresolved: true }),
  ];
  for (const item of cases) {
    const result = decideSettlementRecovery(item);
    assert.equal(result.decision, "operator_reconciliation_required");
    assert.equal(result.requiresOperator, true);
    assert.equal(result.nextStep, "preserve_evidence_and_reconcile_provider_usage");
    assert.ok(result.reasons.length > 0);
  }
});

test("a missing journal with an invalid claim is not treated as safe", () => {
  assert.equal(
    decideSettlementRecovery(inspection({ claim: "invalid" })).decision,
    "operator_reconciliation_required",
  );
});


test("recovery decision fails closed on inconsistent inspection counters", () => {
  const cases: SettlementRunInspection[] = [
    inspection({ journal: "resolved", startedAttempts: -1 }),
    inspection({ journal: "resolved", startedAttempts: 1, settledAttempts: 2 }),
    inspection({ journal: "resolved", startedAttempts: 1, settledAttempts: 1, unknownUsageAttempts: 1, unresolved: false }),
    inspection({ journal: "missing", startedAttempts: 1 }),
  ];
  for (const item of cases) {
    const result = decideSettlementRecovery(item);
    assert.equal(result.decision, "operator_reconciliation_required");
    assert.equal(result.requiresOperator, true);
    assert.ok(result.reasons.some((reason) =>
      reason === "inspection_counts_invalid" || reason === "unknown_usage_reported"));
  }
});


test("a resolved journal cannot contain an unmatched started attempt", () => {
  const result = decideSettlementRecovery(inspection({
    journal: "resolved",
    startedAttempts: 1,
    settledAttempts: 0,
    unresolved: false,
  }));
  assert.equal(result.decision, "operator_reconciliation_required");
  assert.ok(result.reasons.includes("resolved_journal_has_unmatched_attempts"));
});
