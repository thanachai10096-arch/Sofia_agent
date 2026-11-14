import assert from "node:assert/strict";
import test from "node:test";
import {
  RedisTelegramPollLease,
  TELEGRAM_POLL_LEASE_RELEASE_SCRIPT,
  TELEGRAM_POLL_LEASE_RENEW_SCRIPT,
} from "./telegram-poll-lease.js";

test("Redis Telegram poll lease is exclusive and owner-scoped", async () => {
  let owner: string | undefined;
  let ttl = 0;
  const calls: Array<{ script: string; args: string[] }> = [];
  const client = {
    async set(_key: string, value: string, options: { NX: true; PX: number }) {
      if (owner) return null;
      owner = value;
      ttl = options.PX;
      return "OK";
    },
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
      calls.push({ script, args: options.arguments });
      if (script === TELEGRAM_POLL_LEASE_RENEW_SCRIPT) {
        if (owner !== options.arguments[0]) return 0;
        ttl = Number(options.arguments[1]);
        return 1;
      }
      if (script === TELEGRAM_POLL_LEASE_RELEASE_SCRIPT) {
        if (owner !== options.arguments[0]) return 0;
        owner = undefined;
        return 1;
      }
      return 0;
    },
  };
  const lease = new RedisTelegramPollLease({ client, botIdentity: "bot-123", ttlMs: 15_000 });
  const first = await lease.acquire();
  assert.ok(first);
  assert.equal(ttl, 15_000);
  assert.equal(await lease.acquire(), undefined);
  assert.equal(await first.renew(), true);
  assert.equal(ttl, 15_000);
  await first.release();
  assert.equal(owner, undefined);
  assert.equal(await first.renew(), false);
  assert.equal(calls.length, 3);
});

test("Redis Telegram poll lease validates configuration", () => {
  const client = {
    async set() { return null; },
    async eval() { return 0; },
  };
  assert.throws(() => new RedisTelegramPollLease({ client, botIdentity: " " }), /bot identity/);
  assert.throws(() => new RedisTelegramPollLease({ client, botIdentity: "bot", ttlMs: 1_000 }), /TTL/);
});
