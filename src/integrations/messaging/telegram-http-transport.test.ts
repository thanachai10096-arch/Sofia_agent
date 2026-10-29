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

test("Telegram HTTP 409 stops duplicate polling instead of retrying forever", async () => {
  let pollCount = 0;
  const events: Array<{ event: string; status?: number }> = [];
  let conflictResolve!: () => void;
  const conflict = new Promise<void>((resolve) => { conflictResolve = resolve; });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/deleteWebhook")) return ok(true);
    if (url.endsWith("/getUpdates")) {
      pollCount += 1;
      return new Response(JSON.stringify({ ok: false, description: "Conflict: another getUpdates request is active" }), { status: 409 });
    }
    throw new Error("Unexpected Telegram endpoint.");
  };
  const transport = createTelegramHttpTransport({
    token,
    fetchImpl,
    onError(event, status) {
      events.push({ event, status });
      if (event === "poll_conflict") conflictResolve();
    },
  });
  await transport.start(new AbortController().signal, async () => {});
  await Promise.race([
    conflict,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for 409 conflict handling")), 1_000)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pollCount, 1, "a 409 conflict must not create a retry loop");
  assert.deepEqual(events, [{ event: "poll_conflict", status: 409 }]);
  await transport.stop();
});

test("Telegram transport can restart after the duplicate poller is removed", async () => {
  let conflicting = true;
  let updateReturned = false;
  let pollCount = 0;
  const events: Array<{ event: string; status?: number }> = [];
  let conflictResolve!: () => void;
  const conflict = new Promise<void>((resolve) => { conflictResolve = resolve; });
  let updateResolve!: () => void;
  const received = new Promise<void>((resolve) => { updateResolve = resolve; });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/deleteWebhook")) return ok(true);
    if (url.endsWith("/getUpdates")) {
      pollCount += 1;
      if (conflicting) {
        return new Response(JSON.stringify({ ok: false, description: "Conflict: another getUpdates request is active" }), { status: 409 });
      }
      if (!updateReturned) {
        updateReturned = true;
        return ok([{ update_id: 99, message: { message_id: 100 } }]);
      }
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
    onError(event, status) {
      events.push({ event, status });
      if (event === "poll_conflict") conflictResolve();
    },
  });
  await transport.start(new AbortController().signal, async () => {});
  await Promise.race([
    conflict,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for 409 conflict handling")), 1_000)),
  ]);
  await transport.stop();

  conflicting = false;
  await transport.start(new AbortController().signal, async (update) => {
    if (update.update_id === 99) updateResolve();
  });
  await Promise.race([
    received,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for update after restart")), 1_000)),
  ]);
  await transport.stop();

  assert.equal(pollCount, 3);
  assert.deepEqual(events, [{ event: "poll_conflict", status: 409 }]);
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
