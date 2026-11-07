import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { DesktopCommandBroker } from "../desktop/remote-command-broker.js";

test("Desktop Companion API pairs, polls and completes owner-bound commands", async () => {
  const broker = new DesktopCommandBroker();
  const ownerKeyId = createHash("sha256").update("desktop-owner-key").digest("hex").slice(0, 32);
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => ({ id: "test", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 1, healthy: true }), markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: {
      "desktop-owner-key": ["desktop:connect"],
      "other-owner-key": ["desktop:connect"],
      "no-desktop-scope": ["agent:read"],
    },
    desktopCommandBroker: broker,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const request = (path: string, key: string, method = "GET", body?: unknown) => fetch(base + path, {
    method,
    headers: { authorization: "Bearer " + key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await request("/v1/desktop/companion/connect", "no-desktop-scope", "POST")).status, 403);
    const paired = await request("/v1/desktop/companion/connect", "desktop-owner-key", "POST");
    assert.equal(paired.status, 201);
    const { token } = await paired.json() as { token: string };
    assert.equal(typeof token, "string");
    assert.ok(token.length >= 40);

    const otherStatus = await request("/v1/desktop/companion/status", "other-owner-key");
    assert.deepEqual(await otherStatus.json(), { connected: false, pendingCommands: 0 });

    const pending = broker.dispatch(ownerKeyId, { kind: "input.key", key: "Enter" });
    const poll = await fetch(base + "/v1/desktop/companion/commands", {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(poll.status, 200);
    const { command } = await poll.json() as { command: { id: string; action: unknown } };
    assert.deepEqual(command.action, { kind: "input.key", key: "Enter" });

    const completed = await fetch(base + "/v1/desktop/companion/commands/" + command.id + "/complete", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ result: { ok: true } }),
    });
    assert.equal(completed.status, 200);
    assert.deepEqual(await pending, { ok: true });

    const disconnected = await request("/v1/desktop/companion/disconnect", "desktop-owner-key", "POST");
    assert.equal(disconnected.status, 200);
    const stalePoll = await fetch(base + "/v1/desktop/companion/commands", {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(stalePoll.status, 401);
  } finally {
    broker.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Desktop Companion API rejects unauthenticated, oversized and malformed completion", async () => {
  const broker = new DesktopCommandBroker();
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => ({ id: "test", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 1, healthy: true }), markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: { "desktop-owner-key": ["desktop:connect"] },
    desktopCommandBroker: broker,
    maxBodyBytes: 256,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  try {
    assert.equal((await fetch(base + "/v1/desktop/companion/commands")).status, 401);
    const paired = await fetch(base + "/v1/desktop/companion/connect", {
      method: "POST",
      headers: { authorization: "Bearer desktop-owner-key" },
    });
    const { token } = await paired.json() as { token: string };
    const malformed = await fetch(base + "/v1/desktop/companion/commands/not-a-uuid/complete", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ result: {} }),
    });
    assert.equal(malformed.status, 401);
    const oversized = await fetch(base + "/v1/desktop/companion/commands/00000000-0000-4000-8000-000000000000/complete", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ result: "x".repeat(5_500_001) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    broker.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("Desktop Companion API returns 503 for transient store failures without revoking pairing", async () => {
  let now = 1_000;
  let failSave = false;
  const records = new Map<string, { ownerKeyId: string; tokenDigest: string; connectedAt: number; lastSeenAt: number }>();
  const store = {
    loadAll: () => [...records.values()],
    save: (record: { ownerKeyId: string; tokenDigest: string; connectedAt: number; lastSeenAt: number }) => {
      if (failSave) throw new Error("simulated disk failure");
      records.set(record.ownerKeyId, record);
    },
    delete: (ownerKeyId: string) => { records.delete(ownerKeyId); },
  };
  const broker = new DesktopCommandBroker({ store, now: () => now });
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => ({ id: "test", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 1, healthy: true }), markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: { "desktop-owner-key": ["desktop:connect"] },
    desktopCommandBroker: broker,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  try {
    const paired = await fetch(base + "/v1/desktop/companion/connect", {
      method: "POST", headers: { authorization: "Bearer desktop-owner-key" },
    });
    assert.equal(paired.status, 201);
    const { token } = await paired.json() as { token: string };
    now += 60_000;
    failSave = true;
    const transientFailure = await fetch(base + "/v1/desktop/companion/commands", {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(transientFailure.status, 503);
    assert.deepEqual(await transientFailure.json(), { error: "desktop_companion_temporarily_unavailable" });
    failSave = false;
    const recovered = await fetch(base + "/v1/desktop/companion/commands", {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { command: null });
    assert.equal(records.get(createHash("sha256").update("desktop-owner-key").digest("hex").slice(0, 32))?.lastSeenAt, now,
      "a recovered poll must retry and persist the heartbeat that previously failed");
    const invalidToken = await fetch(base + "/v1/desktop/companion/commands", {
      headers: { authorization: "Bearer " + "x".repeat(43) },
    });
    assert.equal(invalidToken.status, 401);
    const oversizedToken = await fetch(base + "/v1/desktop/companion/commands", {
      headers: { authorization: "Bearer " + "z".repeat(257) },
    });
    assert.equal(oversizedToken.status, 401, "malformed bearer tokens are authentication failures, not storage outages");
  } finally {
    broker.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
