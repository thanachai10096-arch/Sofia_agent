import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramHttpTransport } from "./telegram-http-transport.js";

const token = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

test("Telegram transport does not poll when distributed lease is unavailable", async () => {
  const calls: string[] = [];
  const events: string[] = [];
  const transport = createTelegramHttpTransport({
    token,
    pollLease: { async acquire() { return undefined; } },
    fetchImpl: async (input) => {
      calls.push(String(input));
      return ok(true);
    },
    onError(event) { events.push(event); },
  });
  await transport.start(new AbortController().signal, async () => {});
  assert.deepEqual(calls, []);
  assert.deepEqual(events, ["poll_lease_unavailable"]);
  await transport.stop();
});

test("Telegram transport releases its distributed lease after polling stops", async () => {
  const events: string[] = [];
  let released = 0;
  let resolvePoll!: () => void;
  const pollStarted = new Promise<void>((resolve) => { resolvePoll = resolve; });
  const transport = createTelegramHttpTransport({
    token,
    pollLease: {
      async acquire() {
        return {
          ttlMs: 30_000,
          async renew() { return true; },
          async release() { released++; },
        };
      },
    },
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/deleteWebhook")) return ok(true);
      if (String(input).endsWith("/getUpdates")) {
        resolvePoll();
        return await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) { reject(new Error("aborted")); return; }
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return ok(true);
    },
    onError(event) { events.push(event); },
  });
  await transport.start(new AbortController().signal, async () => {});
  await pollStarted;
  await transport.stop();
  assert.equal(released, 1);
  assert.deepEqual(events, []);
});


test("Telegram transport aborts polling when lease renewal hangs past its deadline", async () => {
  const events: string[] = [];
  let released = 0;
  let renewalStarted!: () => void;
  const renewing = new Promise<void>((resolve) => { renewalStarted = resolve; });
  let pollAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { pollAborted = resolve; });
  const transport = createTelegramHttpTransport({
    token,
    pollLeaseRenewIntervalMs: 1_000,
    pollLease: {
      async acquire() {
        return {
          ttlMs: 5_000,
          async renew() {
            renewalStarted();
            return await new Promise<boolean>(() => {});
          },
          async release() { released++; },
        };
      },
    },
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/deleteWebhook")) return ok(true);
      if (String(input).endsWith("/getUpdates")) {
        init?.signal?.addEventListener("abort", () => { pollAborted(); }, { once: true });
        return await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) { pollAborted(); reject(new Error("aborted")); return; }
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return ok(true);
    },
    onError(event) { events.push(event); },
  });
  await transport.start(new AbortController().signal, async () => {});
  await renewing;
  await aborted;
  await transport.stop();
  assert.deepEqual(events, ["poll_lease_lost"]);
  assert.equal(released, 1);
});

test("Telegram transport rejects renewal intervals that can outlive the lease safety window", async () => {
  let released = 0;
  let fetchCalls = 0;
  const transport = createTelegramHttpTransport({
    token,
    pollLeaseRenewIntervalMs: 2_000,
    pollLease: {
      async acquire() {
        return { ttlMs: 5_000, async renew() { return true; }, async release() { released++; } };
      },
    },
    fetchImpl: async () => { fetchCalls++; return ok(true); },
  });
  await assert.rejects(
    () => transport.start(new AbortController().signal, async () => {}),
    /no more than one third of its TTL/,
  );
  assert.equal(released, 1);
  assert.equal(fetchCalls, 0);
});


test("Telegram transport fails closed when lease acquisition hangs", async () => {
  const events: string[] = [];
  let fetchCalls = 0;
  const transport = createTelegramHttpTransport({
    token,
    pollLeaseOperationTimeoutMs: 250,
    pollLease: { async acquire() { return await new Promise(() => {}); } },
    fetchImpl: async () => { fetchCalls++; return ok(true); },
    onError(event) { events.push(event); },
  });
  await transport.start(new AbortController().signal, async () => {});
  assert.deepEqual(events, ["poll_lease_unavailable"]);
  assert.equal(fetchCalls, 0);
  await transport.stop();
});

test("Telegram transport does not hang shutdown when lease release stalls", async () => {
  let pollStarted!: () => void;
  const started = new Promise<void>((resolve) => { pollStarted = resolve; });
  const transport = createTelegramHttpTransport({
    token,
    pollLeaseOperationTimeoutMs: 250,
    pollLease: {
      async acquire() {
        return {
          ttlMs: 30_000,
          async renew() { return true; },
          async release() { return await new Promise<void>(() => {}); },
        };
      },
    },
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/deleteWebhook")) return ok(true);
      if (String(input).endsWith("/getUpdates")) {
        pollStarted();
        return await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) { reject(new Error("aborted")); return; }
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return ok(true);
    },
  });
  await transport.start(new AbortController().signal, async () => {});
  await started;
  await transport.stop();
});
