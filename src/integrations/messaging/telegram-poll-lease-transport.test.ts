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
