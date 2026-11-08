import assert from "node:assert/strict";
import test from "node:test";
import type { RedisEvalClient } from "../../src/integrations/messaging/redis-rate-limiter.js";
import {
  REDIS_DESKTOP_COMMAND_CLAIM_SCRIPT,
  REDIS_DESKTOP_COMMAND_COMPLETE_SCRIPT,
  REDIS_DESKTOP_COMMAND_ENQUEUE_SCRIPT,
  REDIS_DESKTOP_COMMAND_FAIL_SCRIPT,
  REDIS_DESKTOP_COMMAND_GET_SCRIPT,
  REDIS_DESKTOP_COMMAND_PRUNE_TERMINAL_SCRIPT,
  RedisDesktopCommandQueue,
} from "../../src/desktop/redis-command-queue.js";

function memoryRedis(): RedisEvalClient {
  const zsets = new Map<string, Map<string, number>>();
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const zset = (key: string) => { const value = zsets.get(key) ?? new Map<string, number>(); zsets.set(key, value); return value; };
  const hash = (key: string) => { const value = hashes.get(key) ?? new Map<string, string>(); hashes.set(key, value); return value; };
  return {
    async eval(script, { keys, arguments: args }) {
      if (script === REDIS_DESKTOP_COMMAND_PRUNE_TERMINAL_SCRIPT) {
        const expired = [...zset(keys[1]!).entries()].filter(([, score]) => score <= Number(args[0])).slice(0, Number(args[1]));
        for (const [id] of expired) { hash(keys[0]!).delete(id); zset(keys[1]!).delete(id); }
        return expired.length;
      }
      if (script === REDIS_DESKTOP_COMMAND_ENQUEUE_SCRIPT) {
        if (strings.has(keys[3]!)) return ["duplicate", strings.get(keys[3]!)!];
        if (hash(keys[2]!).size >= Number(args[3])) return ["full"];
        if (hash(keys[2]!).has(args[0]!)) return ["id_conflict"];
        hash(keys[2]!).set(args[0]!, args[1]!);
        zset(keys[0]!).set(args[0]!, Number(args[2]));
        if (args[4]) strings.set(keys[3]!, args[0]!);
        return ["created", args[0]!];
      }
      if (script === REDIS_DESKTOP_COMMAND_CLAIM_SCRIPT) {
        const now = Number(args[0]);
        for (const [id, expiry] of [...zset(keys[1]!).entries()]) {
          if (expiry > now) continue;
          const raw = hash(keys[2]!).get(id);
          if (raw) {
            const command = JSON.parse(raw) as Record<string, unknown>;
            delete command.leaseToken; delete command.leaseExpiresAt;
            command.updatedAt = now;
            if (Number(command.attempts) >= Number(command.maxAttempts)) {
              command.status = "failed"; command.error = "Command lease expired after maximum attempts"; zset(keys[3]!).set(id, now);
            } else {
              command.status = "queued"; zset(keys[0]!).set(id, now);
            }
            hash(keys[2]!).set(id, JSON.stringify(command));
          }
          zset(keys[1]!).delete(id);
        }
        const ready = [...zset(keys[0]!).entries()].filter(([, score]) => score <= now).sort((a,b)=>a[1]-b[1])[0];
        if (!ready) return null;
        const [id] = ready;
        const raw = hash(keys[2]!).get(id);
        if (!raw) { zset(keys[0]!).delete(id); return null; }
        const command = JSON.parse(raw) as Record<string, unknown>;
        if (command.status !== "queued") { zset(keys[0]!).delete(id); return null; }
        command.status = "leased"; command.attempts = Number(command.attempts) + 1;
        command.leaseToken = args[2]; command.leaseExpiresAt = now + Number(args[1]); command.updatedAt = now;
        zset(keys[0]!).delete(id); zset(keys[1]!).set(id, Number(command.leaseExpiresAt));
        hash(keys[2]!).set(id, JSON.stringify(command));
        return JSON.stringify(command);
      }
      if (script === REDIS_DESKTOP_COMMAND_COMPLETE_SCRIPT) {
        const raw = hash(keys[1]!).get(args[0]!);
        if (!raw) return 0;
        const command = JSON.parse(raw) as Record<string, unknown>;
        if (command.status !== "leased" || command.leaseToken !== args[1]) return 0;
        command.status = "completed"; command.updatedAt = Number(args[2]); command.result = JSON.parse(args[3]!);
        delete command.leaseToken; delete command.leaseExpiresAt;
        zset(keys[0]!).delete(args[0]!); hash(keys[1]!).set(args[0]!, JSON.stringify(command)); zset(keys[2]!).set(args[0]!, Number(args[2])); return 1;
      }
      if (script === REDIS_DESKTOP_COMMAND_FAIL_SCRIPT) {
        const raw = hash(keys[2]!).get(args[0]!);
        if (!raw) return 0;
        const command = JSON.parse(raw) as Record<string, unknown>;
        if (command.status !== "leased" || command.leaseToken !== args[1]) return 0;
        command.error = args[4]; delete command.leaseToken; delete command.leaseExpiresAt; command.updatedAt = Number(args[2]);
        zset(keys[1]!).delete(args[0]!);
        if (args[3] === "1" && Number(command.attempts) < Number(command.maxAttempts)) {
          command.status = "queued"; zset(keys[0]!).set(args[0]!, Number(args[2]) + Number(args[5]));
        } else { command.status = "failed"; zset(keys[3]!).set(args[0]!, Number(args[2])); }
        hash(keys[2]!).set(args[0]!, JSON.stringify(command)); return 1;
      }
      if (script === REDIS_DESKTOP_COMMAND_GET_SCRIPT) return hash(keys[0]!).get(args[0]!) ?? null;
      throw new Error("Unexpected Redis script");
    },
  };
}

const base = {
  ownerId: "owner-alpha",
  deviceId: "desktop-device-0001",
  type: "desktop.input.click",
  input: { x: 12, y: 24 },
};

test("Redis command queue enqueues and claims a command with an expiring lease", async () => {
  const queue = new RedisDesktopCommandQueue({ client: memoryRedis() });
  const created = await queue.enqueue({ ...base, id: "command-0000001", now: 1_000 });
  assert.equal(created.duplicate, false);
  assert.equal(created.command.status, "queued");
  const claimed = await queue.claim(base.ownerId, base.deviceId, { now: 1_100, leaseMs: 5_000, leaseToken: "lease-token-000001" });
  assert.equal(claimed?.id, "command-0000001");
  assert.equal(claimed?.status, "leased");
  assert.equal(claimed?.attempts, 1);
  assert.equal(claimed?.leaseExpiresAt, 6_100);
});

test("Redis command queue idempotency returns the original command", async () => {
  const queue = new RedisDesktopCommandQueue({ client: memoryRedis() });
  const first = await queue.enqueue({ ...base, id: "command-0000001", idempotencyKey: "client-request-0001", now: 1_000 });
  const second = await queue.enqueue({ ...base, id: "command-0000002", idempotencyKey: "client-request-0001", now: 2_000 });
  assert.equal(second.duplicate, true);
  assert.equal(second.command.id, first.command.id);
  assert.equal(second.command.createdAt, 1_000);
});

test("Redis command queue rejects stale lease tokens and completes only the current lease", async () => {
  const queue = new RedisDesktopCommandQueue({ client: memoryRedis() });
  await queue.enqueue({ ...base, id: "command-0000001", now: 1_000 });
  const claimed = await queue.claim(base.ownerId, base.deviceId, { now: 1_100, leaseToken: "lease-token-000001" });
  assert.ok(claimed);
  assert.equal(await queue.complete(base.ownerId, base.deviceId, claimed.id, "wrong-lease-token", { ok: true }, 1_200), false);
  assert.equal(await queue.complete(base.ownerId, base.deviceId, claimed.id, "lease-token-000001", { ok: true }, 1_200), true);
  assert.equal((await queue.get(base.ownerId, base.deviceId, claimed.id))?.status, "completed");
  assert.equal(await queue.complete(base.ownerId, base.deviceId, claimed.id, "lease-token-000001", { ok: true }, 1_300), false);
});

test("Redis command queue retries failures with delay and stops after max attempts", async () => {
  const queue = new RedisDesktopCommandQueue({ client: memoryRedis() });
  await queue.enqueue({ ...base, id: "command-0000001", now: 1_000, maxAttempts: 2 });
  const first = await queue.claim(base.ownerId, base.deviceId, { now: 1_100, leaseToken: "lease-token-000001" });
  assert.ok(first);
  assert.equal(await queue.fail(base.ownerId, base.deviceId, first.id, "lease-token-000001", { now: 1_200, retryable: true, retryDelayMs: 500, error: "temporary" }), true);
  assert.equal(await queue.claim(base.ownerId, base.deviceId, { now: 1_699 }), null);
  const second = await queue.claim(base.ownerId, base.deviceId, { now: 1_700, leaseToken: "lease-token-000002" });
  assert.equal(second?.attempts, 2);
  assert.equal(await queue.fail(base.ownerId, base.deviceId, second!.id, "lease-token-000002", { now: 1_800, retryable: true, error: "still failing" }), true);
  assert.equal((await queue.get(base.ownerId, base.deviceId, "command-0000001"))?.status, "failed");
});

test("Redis command queue reclaims expired leases and enforces owner/device isolation", async () => {
  const queue = new RedisDesktopCommandQueue({ client: memoryRedis() });
  await queue.enqueue({ ...base, id: "command-0000001", now: 1_000 });
  const first = await queue.claim(base.ownerId, base.deviceId, { now: 1_100, leaseMs: 1_000, leaseToken: "lease-token-000001" });
  assert.ok(first);
  assert.equal(await queue.get("owner-beta", base.deviceId, first.id), null);
  const reclaimed = await queue.claim(base.ownerId, base.deviceId, { now: 2_100, leaseToken: "lease-token-000002" });
  assert.equal(reclaimed?.id, first.id);
  assert.equal(reclaimed?.attempts, 2);
  assert.equal(await queue.complete(base.ownerId, base.deviceId, reclaimed!.id, "lease-token-000001", {}, 2_200), false);
});

test("Redis command queue validates payload sizes, retry settings and identity", async () => {
  const queue = new RedisDesktopCommandQueue({ client: memoryRedis(), maxPayloadBytes: 1_024 });
  await assert.rejects(queue.enqueue({ ...base, id: "bad", now: 1_000 }), /command ID/);
  await assert.rejects(queue.enqueue({ ...base, id: "command-0000001", input: { value: "x".repeat(2_000) } }), /payload too large/);
  await assert.rejects(queue.claim(" ", base.deviceId), /owner ID/);
  await assert.rejects(queue.claim(base.ownerId, base.deviceId, { leaseMs: 100 }), /lease settings/);
});
