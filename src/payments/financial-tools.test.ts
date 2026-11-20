import assert from "node:assert/strict";
import test from "node:test";
import { createFinancialActionTools } from "./financial-tools.js";
import { MemoryFinancialActionStore, MemoryFinancialLedger } from "./financial-actions.js";
import type { FinancialActionDependencies, FinancialPaymentProvider } from "./financial-actions.js";

function setup(provider?: FinancialPaymentProvider): FinancialActionDependencies {
  return {
    store: new MemoryFinancialActionStore(), ledger: new MemoryFinancialLedger(),
    approvals: { async verify(input) { return input.ownerId === "owner-1" && input.approvalId === "approval-1"; } },
    ...(provider ? { provider } : {}),
  };
}

test("registers payment tools with explicit privileged effects", () => {
  const tools = createFinancialActionTools(setup(), "owner-1");
  assert.deepEqual(tools.map((tool) => tool.name), ["finance.payment.execute", "finance.payment.reconcile"]);
  assert.deepEqual(tools[0]?.effects, ["network", "destructive"]);
  assert.deepEqual(tools[1]?.effects, ["network"]);
});

test("payment tool reports unconfigured without attempting a charge", async () => {
  const tools = createFinancialActionTools(setup(), "owner-1");
  const result = await tools[0]!.execute({ orderReference: "ORDER-1", amountMinor: 100, currency: "THB", idempotencyKey: "key-1", approvalId: "approval-1" }, { runtime: {} as never });
  assert.deepEqual(result, { replayed: false, configured: false });
});

test("payment tool submits only after exact approval and returns provider-verified success", async () => {
  let submissions = 0;
  const provider: FinancialPaymentProvider = {
    provider: "test-provider",
    async createPayment() { submissions += 1; },
    async verify(expected) { return { authenticated: true, provider: "test-provider", providerPaymentId: "pay-1", ...expected, status: "succeeded", observedAt: new Date().toISOString() }; },
  };
  const tools = createFinancialActionTools(setup(provider), "owner-1");
  const input = { orderReference: "ORDER-1", amountMinor: 100, currency: "THB", idempotencyKey: "key-1", approvalId: "approval-1" };
  const result = await tools[0]!.execute(input, { runtime: {} as never }) as { record: { status: string }; verification: { verified: boolean } };
  assert.equal(submissions, 1); assert.equal(result.record.status, "succeeded"); assert.equal(result.verification.verified, true);
  await tools[0]!.execute(input, { runtime: {} as never }); assert.equal(submissions, 1);
});

test("reconciliation tool never calls the payment creation method", async () => {
  let submissions = 0;
  const provider: FinancialPaymentProvider = {
    provider: "test-provider", async createPayment() { submissions += 1; },
    async verify(expected) { return { authenticated: true, provider: "test-provider", providerPaymentId: "pay-1", ...expected, status: "processing", observedAt: new Date().toISOString() }; },
  };
  const tools = createFinancialActionTools(setup(provider), "owner-1");
  const input = { orderReference: "ORDER-1", amountMinor: 100, currency: "THB", idempotencyKey: "key-1", approvalId: "approval-1" };
  await tools[0]!.execute(input, { runtime: {} as never });
  const result = await tools[1]!.execute({ idempotencyKey: "key-1" }, { runtime: {} as never }) as { record: { status: string } };
  assert.equal(result.record.status, "processing"); assert.equal(submissions, 1);
});

test("refuses to expose finance tools without a trusted authenticated owner", () => {
  assert.throws(() => createFinancialActionTools(setup(), " "), /authenticated owner/);
});
