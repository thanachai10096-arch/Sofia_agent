import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_OWNERSHIP_ASSERT_SCRIPT,
  RUN_OWNERSHIP_CLAIM_SCRIPT,
  RUN_OWNERSHIP_RELEASE_SCRIPT,
  RUN_OWNERSHIP_RENEW_SCRIPT,
  UpstashRunOwnershipStore,
  type RunOwnershipLease,
} from "./run-ownership-store.js";

function response(result: unknown, ok = true): Response {
  return { ok, json: async () => ({ result }) } as unknown as Response;
}

const input = {
  runId: "run-owner-0001",
  principalId: "tenant-alpha",
  instanceId: "worker-a",
  token: "token_12345678901234567890",
  leaseMs: 15_000,
};

function lease(overrides: Partial<RunOwnershipLease> = {}): RunOwnershipLease {
  return { ...input, generation: 7, ...overrides };
}

test("Upstash run ownership claim uses one cluster slot and returns a fencing generation", async () => {
  let command: unknown[] = [];
  const store = new UpstashRunOwnershipStore({
    url: "https://redis.example.com",
    token: "test-token",
    fetchImpl: async (_url, init) => {
      command = JSON.parse(String(init?.body)) as unknown[];
      return response(7);
    },
  });
  assert.deepEqual(await store.claim(input), lease());
  assert.equal(command[0], "EVAL");
  assert.equal(command[1], RUN_OWNERSHIP_CLAIM_SCRIPT);
  assert.equal(command[2], 3);
  const keys = command.slice(3, 6) as string[];
  assert.ok(keys.every((key) => key.includes("{run:run-owner-0001}")));
  assert.ok(keys.every((key) => key.startsWith("sofia:")));
  assert.match(RUN_OWNERSHIP_CLAIM_SCRIPT, /INCR/u);
  assert.match(RUN_OWNERSHIP_CLAIM_SCRIPT, /PEXPIRE/u);
  assert.match(RUN_OWNERSHIP_CLAIM_SCRIPT, /PTTL/u, "reclaim must inspect the remaining tenant-binding TTL");
  assert.match(RUN_OWNERSHIP_CLAIM_SCRIPT, /bindingTtl < tonumber\(ARGV\[5\]\)/u, "reclaim may extend but never shorten tenant binding");
  assert.ok(Number(command[10]) >= input.leaseMs, "tenant binding must live at least as long as the lease");
  assert.ok(
    RUN_OWNERSHIP_CLAIM_SCRIPT.indexOf("EXISTS', KEYS[1]") <
      RUN_OWNERSHIP_CLAIM_SCRIPT.indexOf("GET', KEYS[3]"),
    "active lease must be checked before a contender can touch tenant binding",
  );
});

test("claim returns no lease when another worker owns the run or tenant binding differs", async () => {
  const results = [0, -1];
  const store = new UpstashRunOwnershipStore({
    url: "https://redis.example.com", token: "test-token",
    fetchImpl: async () => response(results.shift()),
  });
  assert.equal(await store.claim(input), undefined);
  assert.equal(await store.claim({ ...input, principalId: "tenant-beta" }), undefined);
});

test("renew, assert, and release all compare tenant, instance, opaque token, and fencing generation", async () => {
  const commands: unknown[][] = [];
  const store = new UpstashRunOwnershipStore({
    url: "https://redis.example.com", token: "test-token",
    fetchImpl: async (_url, init) => {
      commands.push(JSON.parse(String(init?.body)) as unknown[]);
      return response(1);
    },
  });
  const current = lease();
  assert.equal(await store.renew(current, 20_000), true);
  assert.equal(await store.assertCurrent(current), true);
  assert.equal(await store.release(current), true);
  assert.deepEqual(commands.map((command) => command[1]), [
    RUN_OWNERSHIP_RENEW_SCRIPT,
    RUN_OWNERSHIP_ASSERT_SCRIPT,
    RUN_OWNERSHIP_RELEASE_SCRIPT,
  ]);
  assert.equal(commands[0]?.[2], 2, "renew must atomically include the tenant-binding key");
  assert.equal(commands[0]?.at(-1), 30 * 24 * 60 * 60_000, "renew must extend tenant binding retention");
  for (const script of [RUN_OWNERSHIP_RENEW_SCRIPT, RUN_OWNERSHIP_ASSERT_SCRIPT, RUN_OWNERSHIP_RELEASE_SCRIPT]) {
    assert.match(script, /principalId/u);
    assert.match(script, /instanceId/u);
    assert.match(script, /token/u);
    assert.match(script, /generation/u);
  }
});

test("renewal keeps tenant binding alive for at least the extended lease duration", async () => {
  let command: unknown[] = [];
  const store = new UpstashRunOwnershipStore({
    url: "https://redis.example.com",
    token: "test-token",
    bindingTtlMs: 60_000,
    fetchImpl: async (_url, init) => {
      command = JSON.parse(String(init?.body)) as unknown[];
      return response(1);
    },
  });
  assert.equal(await store.renew(lease(), 120_000), true);
  assert.equal(command.at(-2), "120000", "lease TTL should use the requested duration");
  assert.equal(command.at(-1), "120000", "tenant binding TTL must not be shorter than the renewed lease");
});

test("stale owner cannot renew or release after a newer generation is claimed", async () => {
  const commands: unknown[][] = [];
  const store = new UpstashRunOwnershipStore({
    url: "https://redis.example.com", token: "test-token",
    fetchImpl: async (_url, init) => {
      commands.push(JSON.parse(String(init?.body)) as unknown[]);
      return response(0);
    },
  });
  const stale = lease({ generation: 6, token: "old_token_12345678901234567890" });
  assert.equal(await store.renew(stale, 15_000), false);
  assert.equal(await store.release(stale), false);
  assert.match(String(commands[0]?.[1]), /HGET.*generation/u);
  assert.match(String(commands[1]?.[1]), /HGET.*generation/u);
});

test("Upstash lease adapter rejects invalid identifiers and durations", async () => {
  const store = new UpstashRunOwnershipStore({ url: "https://redis.example.com", token: "test-token", fetchImpl: async () => response(1) });
  await assert.rejects(store.claim({ ...input, runId: "../unsafe" }), /run ID/u);
  await assert.rejects(store.claim({ ...input, token: "short" }), /token/u);
  await assert.rejects(store.claim({ ...input, leaseMs: 10 }), /lease/u);
  await assert.rejects(store.renew(lease(), 10), /lease/u);
});


test("renew, assert, and release reject malformed or forged lease identities before Redis access", async () => {
  let calls = 0;
  const store = new UpstashRunOwnershipStore({
    url: "https://redis.example.com", token: "test-token",
    fetchImpl: async () => { calls += 1; return response(1); },
  });
  await assert.rejects(store.renew(lease({ generation: 0 }), 15_000), /generation/u);
  await assert.rejects(store.assertCurrent(lease({ principalId: " tenant-alpha" })), /principal ID/u);
  await assert.rejects(store.release(lease({ instanceId: "../worker" })), /instance ID/u);
  await assert.rejects(store.assertCurrent(lease({ token: "short" })), /token/u);
  await assert.rejects(store.release(lease({ runId: "../unsafe" })), /run ID/u);
  assert.equal(calls, 0);
});

test("claim rejects non-canonical principal identifiers before contacting Redis", async () => {
  let calls = 0;
  const store = new UpstashRunOwnershipStore({
    url: "https://redis.example.com", token: "test-token",
    fetchImpl: async () => { calls += 1; return response(1); },
  });
  await assert.rejects(store.claim({ ...input, principalId: " tenant-alpha " }), /principal ID/u);
  assert.equal(calls, 0);
});

test("Upstash lease adapter fails closed and never exposes its bearer token", async () => {
  const store = new UpstashRunOwnershipStore({
    url: "https://redis.example.com",
    token: "private-redis-token",
    fetchImpl: async () => { throw new Error("network failure"); },
  });
  await assert.rejects(store.assertCurrent(lease()), (error: Error) => {
    assert.equal(error.message.includes("private-redis-token"), false);
    return /Run ownership Redis request failed/u.test(error.message);
  });
});
