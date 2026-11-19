import assert from "node:assert/strict";
import test from "node:test";
import { authorizeCapability, CapabilityRegistry, type CapabilityDefinition, type DelegatedAuthority } from "./capability-registry.js";

const readCapability: CapabilityDefinition = {
  id: "web.search",
  version: 1,
  description: "Search public web pages.",
  transport: "api",
  effect: "read",
  requiredScopes: ["internet:read"],
  risk: "low",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  supportsIdempotency: true,
};

const orderCapability: CapabilityDefinition = {
  id: "commerce.place-order",
  version: 1,
  description: "Submit an order to an approved merchant.",
  transport: "api",
  effect: "financial",
  requiredScopes: ["commerce:order"],
  risk: "high",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  supportsIdempotency: true,
};

const authority: DelegatedAuthority = {
  principalId: "user-1",
  scopes: ["internet:read", "commerce:order"],
  allowedCapabilityIds: ["web.search", "commerce.place-order"],
  expiresAt: 10_000,
  currency: "THB",
  maxPerTransactionMinor: 20_000,
  maxPerDayMinor: 30_000,
  allowedMerchants: ["merchant-verified"],
};

test("registry rejects duplicate IDs and malformed definitions", () => {
  const registry = new CapabilityRegistry([readCapability]);
  assert.throws(() => registry.register(readCapability), /already registered/);
  assert.throws(() => new CapabilityRegistry([{ ...readCapability, id: "Bad ID" }]), /Invalid capability ID/);
  assert.throws(() => new CapabilityRegistry([{ ...orderCapability, supportsIdempotency: false }]), /idempotency/);
});

test("authorization is default-deny and bound to principal, scope, expiry, and allowlist", () => {
  const registry = new CapabilityRegistry([readCapability]);
  assert.equal(authorizeCapability(registry, undefined, { principalId: "user-1", capabilityId: "web.search" }, 1).allowed, false);
  assert.equal(authorizeCapability(registry, authority, { principalId: "user-2", capabilityId: "web.search" }, 1).allowed, false);
  assert.equal(authorizeCapability(registry, { ...authority, expiresAt: 1 }, { principalId: "user-1", capabilityId: "web.search" }, 1).allowed, false);
  assert.equal(authorizeCapability(registry, { ...authority, scopes: [] }, { principalId: "user-1", capabilityId: "web.search" }, 1).allowed, false);
  assert.equal(authorizeCapability(registry, { ...authority, allowedCapabilityIds: [] }, { principalId: "user-1", capabilityId: "web.search" }, 1).allowed, false);
});

test("read capability can run within granted scope without approval", () => {
  const registry = new CapabilityRegistry([readCapability]);
  const decision = authorizeCapability(registry, authority, { principalId: "user-1", capabilityId: "web.search" }, 1);
  assert.deepEqual(decision, { allowed: true, requiresApproval: false, reason: "Within delegated scope and may execute autonomously." });
});

test("financial capability requires bounded integer amount, currency, merchant and approval", () => {
  const registry = new CapabilityRegistry([orderCapability]);
  const invoke = { principalId: "user-1", capabilityId: "commerce.place-order" };
  assert.equal(authorizeCapability(registry, authority, { ...invoke, amountMinor: 1000, currency: "USD", merchantId: "merchant-verified" }, 1).allowed, false);
  assert.equal(authorizeCapability(registry, authority, { ...invoke, amountMinor: 20_001, currency: "THB", merchantId: "merchant-verified" }, 1).allowed, false);
  assert.equal(authorizeCapability(registry, authority, { ...invoke, amountMinor: 1000.5, currency: "THB", merchantId: "merchant-verified" }, 1).allowed, false);
  assert.equal(authorizeCapability(registry, authority, { ...invoke, amountMinor: 1000, currency: "THB", merchantId: "unknown" }, 1, { currency: "THB", spentTodayMinor: 0 }).allowed, false);
  assert.equal(authorizeCapability(registry, authority, { ...invoke, amountMinor: 1000, currency: "THB", merchantId: "merchant-verified" }, 1).allowed, false);
  assert.equal(authorizeCapability(registry, authority, { ...invoke, amountMinor: 1000, currency: "THB", merchantId: "merchant-verified" }, 1, { currency: "THB", spentTodayMinor: 29_500 }).allowed, false);
  const accepted = authorizeCapability(registry, authority, { ...invoke, amountMinor: 1000, currency: "THB", merchantId: "merchant-verified" }, 1, { currency: "THB", spentTodayMinor: 10_000 });
  assert.equal(accepted.allowed, true);
  if (accepted.allowed) assert.equal(accepted.requiresApproval, true);
});

test("financial capability cannot be registered over unrestricted desktop transport", () => {
  assert.throws(() => new CapabilityRegistry([{ ...orderCapability, transport: "desktop" }]), /desktop transport/);
});
