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
  assert.equal(pollBodies[0].offset, undefined);
  assert.equal(pollBodies[1].offset, 41);
  const sendBody = JSON.parse(String(requests.find((request) => request.url.endsWith("/sendMessage"))?.init?.body));
  assert.equal(sendBody.chat_id, "chat-1");
  assert.equal(sendBody.text, "hello");
  assert.equal(sendBody.reply_parameters.message_id, 8);
});

test("Telegram transport rejects malformed tokens and poll timeouts", () => {
  assert.throws(() => createTelegramHttpTransport({ token: "not-a-token" }), /token/);
  assert.throws(() => createTelegramHttpTransport({ token, pollTimeoutSeconds: 51 }), /timeout/);
});

test("Telegram delivery errors are sanitized and surfaced to the caller", async () => {
  const errorEvents: string[] = [];
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ ok: false, description: "secret-bearing provider detail" }), { status: 403 });
  const transport = createTelegramHttpTransport({ token, fetchImpl, onError(event) { errorEvents.push(event); } });
  await transport.start(new AbortController().signal, async () => {});
  await assert.rejects(() => transport.sendMessage("chat-1", "hello"), /delivery failed/);
  assert.ok(errorEvents.includes("delivery_failed"));
  await transport.stop();
});
