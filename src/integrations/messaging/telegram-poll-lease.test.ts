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
  assert.equal(first.ttlMs, 15_000);
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

test("Redis Telegram poll lease grants exactly one owner under concurrent acquisition", async () => {
  let owner: string | undefined;
  let setCalls = 0;
  const client = {
    async set(_key: string, value: string, options: { NX: true; PX: number }) {
      setCalls++;
      // Model Redis SET NX as one atomic operation in the event loop.
      if (owner !== undefined) return null;
      owner = value;
      assert.equal(options.NX, true);
      assert.equal(options.PX, 15_000);
      return "OK";
    },
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
      if (script === TELEGRAM_POLL_LEASE_RELEASE_SCRIPT) {
        if (owner !== options.arguments[0]) return 0;
        owner = undefined;
        return 1;
      }
      if (script === TELEGRAM_POLL_LEASE_RENEW_SCRIPT) {
        return owner === options.arguments[0] ? 1 : 0;
      }
      return 0;
    },
  };
  const lease = new RedisTelegramPollLease({ client, botIdentity: "concurrent-bot", ttlMs: 15_000 });
  const results = await Promise.all(Array.from({ length: 16 }, () => lease.acquire()));
  assert.equal(setCalls, 16);
  assert.equal(results.filter((item) => item !== undefined).length, 1);
  const winner = results.find((item) => item !== undefined);
  assert.ok(winner);
  assert.equal(await winner.renew(), true);
  await winner.release();
  assert.equal(owner, undefined);
});

test("expired former Telegram poll lease owner cannot renew or release its successor lease", async () => {
  let owner: string | undefined;
  const client = {
    async set(_key: string, value: string) {
      if (owner !== undefined) return null;
      owner = value;
      return "OK";
    },
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
      if (owner !== options.arguments[0]) return 0;
      if (script === TELEGRAM_POLL_LEASE_RENEW_SCRIPT) return 1;
      if (script === TELEGRAM_POLL_LEASE_RELEASE_SCRIPT) {
        owner = undefined;
        return 1;
      }
      return 0;
    },
  };
  const lease = new RedisTelegramPollLease({ client, botIdentity: "successor-bot", ttlMs: 15_000 });
  const formerOwner = await lease.acquire();
  assert.ok(formerOwner);
  // Simulate TTL expiry followed by a different process acquiring the key.
  owner = undefined;
  const successor = await lease.acquire();
  assert.ok(successor);
  const successorToken = owner;
  assert.equal(await formerOwner.renew(), false);
  await formerOwner.release();
  assert.equal(owner, successorToken);
  assert.equal(await successor.renew(), true);
  await successor.release();
  assert.equal(owner, undefined);
});

test("Redis Telegram poll lease can retry release after a transient Redis error", async () => {
  let owner: string | undefined;
  let releaseAttempts = 0;
  const client = {
    async set(_key: string, value: string) {
      owner = value;
      return "OK";
    },
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
      if (script !== TELEGRAM_POLL_LEASE_RELEASE_SCRIPT) return 0;
      releaseAttempts++;
      if (releaseAttempts === 1) throw new Error("temporary Redis failure");
      if (owner !== options.arguments[0]) return 0;
      owner = undefined;
      return 1;
    },
  };
  const lease = new RedisTelegramPollLease({ client, botIdentity: "retry-release-bot", ttlMs: 15_000 });
  const handle = await lease.acquire();
  assert.ok(handle);
  await assert.rejects(() => handle.release(), /temporary Redis failure/);
  assert.notEqual(owner, undefined);
  await handle.release();
  assert.equal(releaseAttempts, 2);
  assert.equal(owner, undefined);
  await handle.release();
  assert.equal(releaseAttempts, 2);
});
