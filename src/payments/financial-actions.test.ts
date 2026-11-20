import assert from "node:assert/strict";
import test from "node:test";
import { executeFinancialAction, reconcileFinancialAction, MemoryFinancialActionStore, MemoryFinancialLedger, type FinancialActionRequest, type FinancialPaymentProvider } from "./financial-actions.js";

const request: FinancialActionRequest = { ownerId: "user-1", idempotencyKey: "checkout-001", approvalId: "approval-1", orderReference: "ORDER-9", amountMinor: 2500, currency: "THB" };
function deps(provider?: FinancialPaymentProvider) {
  const store = new MemoryFinancialActionStore(), ledger = new MemoryFinancialLedger(); let submissions = 0;
  const paymentProvider: FinancialPaymentProvider = provider ?? { provider: "test-provider", createPayment: async () => { submissions++; },
    verify: async () => ({ authenticated: true, provider: "test-provider", providerPaymentId: "pay_9", orderReference: "ORDER-9", amountMinor: 2500, currency: "THB", status: "succeeded", observedAt: new Date().toISOString() }) };
  return { store, ledger, approvals: { verify: async () => true }, provider: paymentProvider, submitted: () => submissions };
}

test("does not attempt a charge without a configured provider", async () => {
  const d = deps(); const result = await executeFinancialAction(request, { store: d.store, ledger: d.ledger, approvals: d.approvals });
  assert.equal(result.configured, false); assert.equal(d.submitted(), 0);
});
test("requires transaction-specific approval", async () => {
  const d = deps(); await assert.rejects(executeFinancialAction(request, { ...d, approvals: { verify: async () => false } }), /approval/);
  assert.equal(d.submitted(), 0);
});
test("submits once and records authenticated provider success", async () => {
  const d = deps(); const result = await executeFinancialAction(request, d);
  assert.equal(result.record?.status, "succeeded"); assert.equal(result.verification?.verified, true); assert.equal(d.submitted(), 1);
  assert.deepEqual(d.ledger.snapshot().map(x => x.type), ["prepared", "submitted", "verified"]);
});
test("replays the same idempotency key without a second submission", async () => {
  const d = deps(); await executeFinancialAction(request, d); const replay = await executeFinancialAction(request, d);
  assert.equal(replay.replayed, true); assert.equal(d.submitted(), 1);
});
test("rejects reuse of an idempotency key for a different amount", async () => {
  const d = deps(); await executeFinancialAction(request, d);
  await assert.rejects(executeFinancialAction({ ...request, amountMinor: 3000 }, d), /idempotency_key_reused/);
});
test("records provider submission exceptions as unknown, not failed", async () => {
  const d = deps({ provider: "test-provider", createPayment: async () => { throw new Error("timeout"); }, verify: async () => null });
  const result = await executeFinancialAction(request, d);
  assert.equal(result.record?.status, "unknown"); assert.match(result.record?.reason ?? "", /uncertain/);
  assert.equal(d.ledger.snapshot().at(-1)?.type, "uncertain");
});
test("does not treat an unauthenticated or processing provider result as success", async () => {
  const d = deps({ provider: "test-provider", createPayment: async () => {}, verify: async () => ({ authenticated: true, provider: "test-provider", providerPaymentId: "pay_9", orderReference: "ORDER-9", amountMinor: 2500, currency: "THB", status: "processing", observedAt: new Date().toISOString() }) });
  const result = await executeFinancialAction(request, d); assert.equal(result.record?.status, "processing"); assert.equal(result.verification?.verified, false);
});
test("reconciles an uncertain submission without submitting a second payment", async () => {
  let submissions = 0, reconciled = false;
  const provider: FinancialPaymentProvider = { provider: "test-provider", createPayment: async () => { submissions++; throw new Error("network timeout"); },
    verify: async () => reconciled ? ({ authenticated: true, provider: "test-provider", providerPaymentId: "pay_reconciled", orderReference: "ORDER-9", amountMinor: 2500, currency: "THB", status: "succeeded", observedAt: new Date().toISOString() }) : null };
  const d = deps(provider); const first = await executeFinancialAction(request, d);
  assert.equal(first.record?.status, "unknown"); assert.equal(submissions, 1);
  reconciled = true;
  const result = await reconcileFinancialAction({ ownerId: request.ownerId, idempotencyKey: request.idempotencyKey }, d);
  assert.equal(result.record?.status, "succeeded"); assert.equal(result.verification?.verified, true); assert.equal(submissions, 1);
});