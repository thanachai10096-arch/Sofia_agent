import assert from "node:assert/strict";
import test from "node:test";
import { verifyPayment, type PaymentVerificationAdapter } from "./verification.js";

const expected = { orderReference: "ORDER-123", amountMinor: 4250, currency: "USD" };
const payment = { authenticated: true, provider: "example-provider", providerPaymentId: "pay_123",
  orderReference: "ORDER-123", amountMinor: 4250, currency: "USD", status: "succeeded" as const,
  observedAt: "2026-11-20T10:00:00.000Z" };

test("does not claim payment success when no provider is configured", async () => {
  const result = await verifyPayment(expected);
  assert.equal(result.status, "unknown");
  assert.equal(result.verified, false);
});

test("accepts only an authenticated provider success matching order, amount and currency", async () => {
  const adapter: PaymentVerificationAdapter = { provider: "example-provider", verify: async () => payment };
  const result = await verifyPayment(expected, adapter);
  assert.equal(result.status, "succeeded");
  assert.equal(result.verified, true);
  assert.equal(result.providerPaymentId, "pay_123");
});

test("rejects unauthenticated provider responses", async () => {
  const adapter: PaymentVerificationAdapter = { provider: "example-provider", verify: async () => ({ ...payment, authenticated: false }) };
  const result = await verifyPayment(expected, adapter);
  assert.equal(result.status, "unknown");
  assert.equal(result.verified, false);
});

test("detects authenticated payment amount, currency and order mismatches", async () => {
  const adapter: PaymentVerificationAdapter = { provider: "example-provider", verify: async () => ({ ...payment, amountMinor: 4200 }) };
  const result = await verifyPayment(expected, adapter);
  assert.equal(result.status, "mismatch");
  assert.equal(result.verified, false);
});

test("does not equate pending or failed provider states with success", async () => {
  const pending: PaymentVerificationAdapter = { provider: "example-provider", verify: async () => ({ ...payment, status: "processing" }) };
  const failed: PaymentVerificationAdapter = { provider: "example-provider", verify: async () => ({ ...payment, status: "failed" }) };
  assert.equal((await verifyPayment(expected, pending)).verified, false);
  assert.equal((await verifyPayment(expected, pending)).status, "processing");
  assert.equal((await verifyPayment(expected, failed)).status, "failed");
});

test("rejects invalid expected payment values", async () => {
  await assert.rejects(verifyPayment({ ...expected, amountMinor: -1 }));
  await assert.rejects(verifyPayment({ ...expected, currency: "usd" }));
});
