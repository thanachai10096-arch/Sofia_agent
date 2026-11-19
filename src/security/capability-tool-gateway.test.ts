import assert from "node:assert/strict";
import test from "node:test";
import type { ToolGateway } from "../brain/types.js";
import { CapabilityRegistry, type CapabilityDefinition, type DelegatedAuthority } from "./capability-registry.js";
import { CapabilityGuardToolGateway } from "./capability-tool-gateway.js";

const capability: CapabilityDefinition = {
  id: "web.search",
  version: 1,
  description: "Search the web.",
  transport: "api",
  effect: "read",
  requiredScopes: ["internet:read"],
  risk: "low",
  inputSchema: { type: "object" },
  supportsIdempotency: true,
};
const authority: DelegatedAuthority = {
  principalId: "principal-1",
  scopes: ["internet:read"],
  allowedCapabilityIds: ["web.search"],
  expiresAt: Date.now() + 60_000,
};

function gatewayStub(effects: readonly ("read" | "write" | "shell" | "network" | "browser" | "destructive")[] = ["read"]) {
  let executions = 0;
  const inner: ToolGateway = {
    listTools: () => [{ name: "browser.search", description: "Search", effects }],
    describe: name => name === "browser.search" ? { effects } : undefined,
    async execute() { executions += 1; return { ok: true, data: { found: true }, evidenceId: "evidence-1" }; },
    async snapshot() { return { id: "s", revision: "r", evidenceId: "e" }; },
    async changedFiles() { return []; },
    async checkpoint() { return { id: "c", revision: "r" }; },
    async rollback() { return []; },
  };
  return { inner, count: () => executions };
}

const context = {
  runId: "run-1",
  principalId: "principal-1",
  signal: new AbortController().signal,
  requireApproval: false,
  notifyApproval: () => {},
};

test("guarded gateway only executes capabilities granted to the authenticated principal", async () => {
  const stub = gatewayStub();
  const gateway = new CapabilityGuardToolGateway(stub.inner, new CapabilityRegistry([capability]), async () => authority, () => "web.search");
  const result = await gateway.execute({ tool: "browser.search", input: {} }, context);
  assert.equal(result.ok, true);
  assert.equal(stub.count(), 1);
});

test("guarded gateway denies missing principal, missing grant, and unregistered tools", async () => {
  const stub = gatewayStub();
  const gateway = new CapabilityGuardToolGateway(stub.inner, new CapabilityRegistry([capability]), async () => authority, () => "web.search");
  assert.equal((await gateway.execute({ tool: "browser.search", input: {} }, { ...context, principalId: undefined })).ok, false);
  const noGrant = new CapabilityGuardToolGateway(stub.inner, new CapabilityRegistry([capability]), async () => ({ ...authority, allowedCapabilityIds: [] }), () => "web.search");
  assert.equal((await noGrant.execute({ tool: "browser.search", input: {} }, context)).ok, false);
  assert.equal((await gateway.execute({ tool: "not.registered", input: {} }, context)).ok, false);
  assert.equal(stub.count(), 0);
});

test("bounded delegated external actions execute without repeated approval", async () => {
  const sideEffect = { ...capability, id: "commerce.submit", effect: "external_side_effect" as const, risk: "high" as const };
  const stub = gatewayStub(["browser"]);
  const gateway = new CapabilityGuardToolGateway(stub.inner, new CapabilityRegistry([sideEffect]), async () => ({
    ...authority, scopes: ["internet:read"], allowedCapabilityIds: ["commerce.submit"],
  }), () => "commerce.submit");
  assert.equal((await gateway.execute({ tool: "browser.search", input: {} }, context)).ok, true);
  assert.equal(stub.count(), 1);
});

test("explicit approval and critical capabilities still require approval", async () => {
  const explicit = { ...capability, id: "commerce.confirm", effect: "external_side_effect" as const, risk: "high" as const, approvalRequired: true };
  const stub = gatewayStub(["browser"]);
  const gateway = new CapabilityGuardToolGateway(stub.inner, new CapabilityRegistry([explicit]), async () => ({
    ...authority, scopes: ["internet:read"], allowedCapabilityIds: ["commerce.confirm"],
  }), () => "commerce.confirm");
  assert.equal((await gateway.execute({ tool: "browser.search", input: {} }, context)).ok, false);
  assert.equal((await gateway.execute({ tool: "browser.search", input: {} }, { ...context, requireApproval: true })).ok, true);
  const critical = { ...explicit, id: "system.destroy", approvalRequired: false, risk: "critical" as const };
  const criticalGateway = new CapabilityGuardToolGateway(stub.inner, new CapabilityRegistry([critical]), async () => ({
    ...authority, scopes: ["internet:read"], allowedCapabilityIds: ["system.destroy"],
  }), () => "system.destroy");
  assert.equal((await criticalGateway.execute({ tool: "browser.search", input: {} }, context)).ok, false);
});


test("capability mappings cannot downgrade a write tool to read-only", async () => {
  const writeStub = gatewayStub(["write"]);
  const gateway = new CapabilityGuardToolGateway(
    writeStub.inner,
    new CapabilityRegistry([capability]),
    async () => authority,
    () => "web.search",
  );
  const result = await gateway.execute({ tool: "browser.search", input: {} }, context);
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /risk is lower|effect does not match/i);
  assert.equal(writeStub.count(), 0);
});


test("network-only read tools cannot be relabeled as external side effects", async () => {
  const sideEffect = { ...capability, id: "commerce.send", effect: "external_side_effect" as const, risk: "high" as const };
  const stub = gatewayStub(["network", "read"]);
  const gateway = new CapabilityGuardToolGateway(
    stub.inner,
    new CapabilityRegistry([sideEffect]),
    async () => ({ ...authority, allowedCapabilityIds: ["commerce.send"] }),
    () => "commerce.send",
  );
  const result = await gateway.execute({ tool: "browser.search", input: {} }, context);
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /effect does not match/i);
  assert.equal(stub.count(), 0);
});

test("unmapped production tools fail closed", async () => {
  const stub = gatewayStub();
  const gateway = new CapabilityGuardToolGateway(
    stub.inner,
    new CapabilityRegistry([capability]),
    async () => authority,
    () => undefined,
  );
  assert.equal((await gateway.execute({ tool: "browser.search", input: {} }, context)).ok, false);
  assert.equal(stub.count(), 0);
});

test("guarded gateway blocks financial execution until transaction executor is integrated", async () => {
  const financial = { ...capability, id: "commerce.place-order", effect: "financial" as const, risk: "high" as const };
  const stub = gatewayStub();
  const gateway = new CapabilityGuardToolGateway(stub.inner, new CapabilityRegistry([financial]), async () => ({
    ...authority, scopes: ["internet:read"], allowedCapabilityIds: ["commerce.place-order"],
  }), () => "commerce.place-order");
  const result = await gateway.execute({ tool: "browser.search", input: { amountMinor: 500, currency: "THB", merchantId: "merchant-1" } }, context);
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /Financial execution is disabled/);
  assert.equal(stub.count(), 0);
});

test("API capabilities cannot be mapped to browser-control tools", async () => {
  const apiSideEffect = {
    ...capability,
    id: "commerce.api-submit",
    effect: "external_side_effect" as const,
    risk: "high" as const,
    transport: "api" as const,
  };
  const stub = gatewayStub(["browser"]);
  const gateway = new CapabilityGuardToolGateway(
    stub.inner,
    new CapabilityRegistry([apiSideEffect]),
    async () => ({ ...authority, allowedCapabilityIds: ["commerce.api-submit"] }),
    () => "commerce.api-submit",
  );
  const result = await gateway.execute({ tool: "browser.search", input: {} }, context);
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /API capability cannot be mapped/i);
  assert.equal(stub.count(), 0);
});
