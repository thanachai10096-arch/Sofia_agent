import assert from "node:assert/strict";
import test from "node:test";
import { createSofiaApi } from "../../src/api/server.js";
import type { AgentDependencies } from "../../src/agent/types.js";
import {
  DesktopDeviceEnrollmentService,
  type DesktopEnrollmentChallenge,
  type DesktopEnrollmentChallengeStore,
} from "../../src/desktop/device-enrollment.js";
import {
  DesktopDeviceCredentialVault,
  type DesktopDeviceRecord,
  type DesktopDeviceRegistryStore,
} from "../../src/desktop/device-registry.js";
import type { MessagingRateLimiter } from "../../src/integrations/messaging/gateway.js";

class ChallengeStore implements DesktopEnrollmentChallengeStore {
  readonly items = new Map<string, DesktopEnrollmentChallenge>();
  async create(hash: string, value: DesktopEnrollmentChallenge): Promise<void> {
    if (this.items.has(hash)) throw new Error("duplicate");
    this.items.set(hash, value);
  }
  async consume(hash: string): Promise<DesktopEnrollmentChallenge | null> {
    const value = this.items.get(hash) ?? null;
    this.items.delete(hash);
    return value;
  }
}
class Registry implements DesktopDeviceRegistryStore {
  readonly items = new Map<string, DesktopDeviceRecord>();
  async create(value: DesktopDeviceRecord): Promise<void> { this.items.set(value.id, value); }
  async getOwned(owner: string, id: string): Promise<DesktopDeviceRecord | null> {
    const item = this.items.get(id);
    return item?.ownerId === owner ? item : null;
  }
  async listOwned(owner: string): Promise<readonly DesktopDeviceRecord[]> {
    return [...this.items.values()].filter((item) => item.ownerId === owner);
  }
  async revokeOwned(owner: string, id: string, at: number): Promise<boolean> {
    const item = await this.getOwned(owner, id);
    if (!item || item.revokedAt !== undefined) return false;
    this.items.set(id, { ...item, revokedAt: at });
    return true;
  }
}
const TOKEN = "desktop-owner-token";
const OTHER = "other-owner-token";
async function start() {
  const registry = new Registry();
  const challenges = new ChallengeStore();
  const service = new DesktopDeviceEnrollmentService({
    registry, challenges,
    vault: new DesktopDeviceCredentialVault({ masterKey: Buffer.alloc(32, 3) }),
    createDeviceId: () => "desktop-device-0001",
  });
  let attempts = 0;
  const limiter: MessagingRateLimiter = {
    consume: async () => { attempts += 1; return attempts <= 5; },
  };
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { [TOKEN]: ["desktop:manage"], [OTHER]: ["desktop:manage"], ["read-only"]: ["agent:run"] },
    desktopEnrollment: { service, registry, completionRateLimiter: limiter },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const request = (token: string, path: string, init: RequestInit = {}) => fetch(base + path, {
    ...init,
    headers: { authorization: "Bearer " + token, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  return { server, request, base, registry, getAttempts: () => attempts };
}

test("desktop enrollment API requires manage scope and returns a one-time code", async (t) => {
  const ctx = await start();
  t.after(() => new Promise<void>((resolve) => ctx.server.close(() => resolve())));
  assert.equal((await ctx.request("read-only", "/v1/desktop/enrollments", { method: "POST" })).status, 403);
  const response = await ctx.request(TOKEN, "/v1/desktop/enrollments", { method: "POST" });
  assert.equal(response.status, 201);
  const value = await response.json() as { code: string; expiresAt: number };
  assert.equal(value.code.length, 43);
  assert.ok(value.expiresAt > Date.now());
});

test("desktop enrollment completion is code-authenticated, rate-limited, and never returns the secret", async (t) => {
  const ctx = await start();
  t.after(() => new Promise<void>((resolve) => ctx.server.close(() => resolve())));
  const enrollment = await (await ctx.request(TOKEN, "/v1/desktop/enrollments", { method: "POST" })).json() as { code: string };
  const deviceSecret = Buffer.alloc(32, 8);
  const response = await fetch(ctx.base + "/v1/desktop/enrollments/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: enrollment.code, displayName: "My PC", capabilities: ["system:discover"],
      deviceSecret: deviceSecret.toString("base64url"),
    }),
  });
  assert.equal(response.status, 201);
  const payload = await response.json() as { device: Record<string, unknown> };
  assert.equal(payload.device.id, "desktop-device-0001");
  assert.equal("credential" in payload.device, false);
  assert.equal("deviceSecret" in payload.device, false);
  const replay = await fetch(ctx.base + "/v1/desktop/enrollments/complete", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: enrollment.code, displayName: "My PC", capabilities: ["system:discover"],
      deviceSecret: deviceSecret.toString("base64url"),
    }),
  });
  assert.equal(replay.status, 400);
  assert.equal(ctx.getAttempts(), 2);
});

test("desktop device list and revoke remain owner-scoped", async (t) => {
  const ctx = await start();
  t.after(() => new Promise<void>((resolve) => ctx.server.close(() => resolve())));
  const enrollment = await (await ctx.request(TOKEN, "/v1/desktop/enrollments", { method: "POST" })).json() as { code: string };
  const secret = Buffer.alloc(32, 8).toString("base64url");
  const complete = await fetch(ctx.base + "/v1/desktop/enrollments/complete", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: enrollment.code, displayName: "My PC", capabilities: [], deviceSecret: secret }),
  });
  assert.equal(complete.status, 201);
  const listed = await (await ctx.request(TOKEN, "/v1/desktop/devices")).json() as { devices: Record<string, unknown>[] };
  assert.equal(listed.devices.length, 1);
  assert.equal("credential" in listed.devices[0]!, false);
  const id = String(listed.devices[0]!.id);
  assert.equal((await ctx.request(OTHER, "/v1/desktop/devices/" + id, { method: "DELETE" })).status, 404);
  assert.equal((await ctx.request(TOKEN, "/v1/desktop/devices/" + id, { method: "DELETE" })).status, 200);
  assert.equal((await ctx.request(TOKEN, "/v1/desktop/devices/" + id, { method: "DELETE" })).status, 404);
});

test("desktop enrollment completion fails closed when rate limiter rejects or errors", async (t) => {
  const registry = new Registry();
  const challenges = new ChallengeStore();
  const service = new DesktopDeviceEnrollmentService({
    registry, challenges,
    vault: new DesktopDeviceCredentialVault({ masterKey: Buffer.alloc(32, 4) }),
  });
  const makeServer = (limiter: MessagingRateLimiter) => createSofiaApi({} as AgentDependencies, {
    apiKeys: { [TOKEN]: ["desktop:manage"] },
    desktopEnrollment: { service, registry, completionRateLimiter: limiter },
  });
  const denied = makeServer({ consume: async () => false });
  await new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve));
  const a = denied.address(); assert.ok(a && typeof a !== "string");
  t.after(() => new Promise<void>((resolve) => denied.close(() => resolve())));
  const blocked = await fetch("http://127.0.0.1:" + a.port + "/v1/desktop/enrollments/complete", { method: "POST" });
  assert.equal(blocked.status, 429);

  const failed = makeServer({ consume: async () => { throw new Error("redis down"); } });
  await new Promise<void>((resolve) => failed.listen(0, "127.0.0.1", resolve));
  const b = failed.address(); assert.ok(b && typeof b !== "string");
  t.after(() => new Promise<void>((resolve) => failed.close(() => resolve())));
  const unavailable = await fetch("http://127.0.0.1:" + b.port + "/v1/desktop/enrollments/complete", { method: "POST" });
  assert.equal(unavailable.status, 503);
});
