import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramHttpTransport } from "./telegram-http-transport.js";

const token = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

test("Telegram HTTP transport polls, advances update offset, sends replies and stops", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let pollCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/getUpdates")) {
      pollCount++;
      if (pollCount === 1) return ok([{ update_id: 40, message: { message_id: 8 } }]);
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) { reject(new Error("aborted")); return; }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (url.endsWith("/sendMessage")) return ok({ message_id: 9 });
    if (url.endsWith("/deleteWebhook")) return ok(true);
    throw new Error("Unexpected Telegram endpoint.");
  };
  const transport = createTelegramHttpTransport({ token, fetchImpl, pollTimeoutSeconds: 2 });
  let receivedResolve!: () => void;
  const received = new Promise<void>((resolve) => { receivedResolve = resolve; });
  await transport.start(new AbortController().signal, async (update) => {
    assert.equal(update.update_id, 40);
    receivedResolve();
  });
  await Promise.race([
    received,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for update")), 1_000)),
  ]);
  const receipt = await transport.sendMessage("chat-1", "hello", "8");
  assert.deepEqual(receipt, { messageId: "9" });
  await transport.stop();

  const pollBodies = requests.filter((request) => request.url.endsWith("/getUpdates"))
    .map((request) => JSON.parse(String(request.init?.body)) as Record<string, unknown>);
  assert.equal(pollBodies[0]?.offset, undefined);
  assert.equal(pollBodies[1]?.offset, 41);
  const sendBody = JSON.parse(String(requests.find((request) => request.url.endsWith("/sendMessage"))?.init?.body));
  assert.equal(sendBody.chat_id, "chat-1");
  assert.equal(sendBody.text, "hello");
  assert.equal(sendBody.reply_parameters.message_id, 8);
});

test("a failed update handler does not block later updates or repeat the failed update", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const errorEvents: string[] = [];
  let pollCount = 0;
  let laterUpdateResolve!: () => void;
  const laterUpdate = new Promise<void>((resolve) => { laterUpdateResolve = resolve; });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/deleteWebhook")) return ok(true);
    if (url.endsWith("/getUpdates")) {
      pollCount++;
      if (pollCount === 1) return ok([{ update_id: 40 }, { update_id: 41 }]);
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) { reject(new Error("aborted")); return; }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    throw new Error("Unexpected Telegram endpoint.");
  };
  const transport = createTelegramHttpTransport({
    token,
    fetchImpl,
    onError(event) { errorEvents.push(event); },
  });
  await transport.start(new AbortController().signal, async (update) => {
    if (update.update_id === 40) throw new Error("private task details must not be logged");
    if (update.update_id === 41) laterUpdateResolve();
  });
  await Promise.race([
    laterUpdate,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for later update")), 1_000)),
  ]);
  await transport.stop();

  const pollBodies = requests.filter((request) => request.url.endsWith("/getUpdates"))
    .map((request) => JSON.parse(String(request.init?.body)) as Record<string, unknown>);
  assert.equal(pollBodies.length, 2);
  assert.equal(pollBodies[1]?.offset, 42);
  assert.deepEqual(errorEvents, ["update_failed"]);
});

test("HTTP 409 stops polling instead of retrying a competing getUpdates consumer", async () => {
  const errorEvents: Array<{ event: string; status?: number }> = [];
  let pollCount = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/deleteWebhook")) return ok(true);
    if (url.endsWith("/getUpdates")) {
      pollCount++;
      return new Response(JSON.stringify({
        ok: false,
        description: "Conflict: terminated by other getUpdates request",
      }), { status: 409 });
    }
    throw new Error("Unexpected Telegram endpoint.");
  };
  const transport = createTelegramHttpTransport({
    token,
    fetchImpl,
    onError(event, status) { errorEvents.push({ event, ...(status === undefined ? {} : { status }) }); },
  });
  await transport.start(new AbortController().signal, async () => {});
  // The poll loop should terminate on the first 409 without entering backoff/retry.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await transport.stop();
  assert.equal(pollCount, 1);
  assert.deepEqual(errorEvents, [{ event: "poll_conflict", status: 409 }]);
});

test("Telegram transport rejects malformed tokens and poll timeouts", () => {
  assert.throws(() => createTelegramHttpTransport({ token: "not-a-token" }), /token/);
  assert.throws(() => createTelegramHttpTransport({ token, pollTimeoutSeconds: 51 }), /timeout/);
});

test("Telegram delivery errors are sanitized and surfaced to the caller", async () => {
  const errorEvents: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/deleteWebhook")) return ok(true);
    return new Response(JSON.stringify({ ok: false, description: "secret-bearing provider detail" }), { status: 403 });
  };
  const transport = createTelegramHttpTransport({ token, fetchImpl, onError(event) { errorEvents.push(event); } });
  await transport.start(new AbortController().signal, async () => {});
  await assert.rejects(() => transport.sendMessage("chat-1", "hello"), /delivery failed/);
  assert.ok(errorEvents.includes("delivery_failed"));
  await transport.stop();
});
