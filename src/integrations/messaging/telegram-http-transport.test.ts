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

test("Telegram polling backs off and recovers after a transient HTTP 409 conflict", async () => {
  let pollCount = 0;
  let recoveredResolve!: () => void;
  const recovered = new Promise<void>((resolve) => { recoveredResolve = resolve; });
  const errorEvents: Array<{ event: string; status?: number }> = [];
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/deleteWebhook")) return ok(true);
    if (String(input).endsWith("/getUpdates")) {
      pollCount++;
      if (pollCount === 1) return new Response(JSON.stringify({ ok: false, description: "Conflict: terminated by other getUpdates request" }), { status: 409 });
      recoveredResolve();
      return ok([]);
    }
    throw new Error("Unexpected Telegram endpoint.");
  };
  const transport = createTelegramHttpTransport({
    token,
    fetchImpl,
    onError(event, status) { errorEvents.push({ event, ...(status ? { status } : {}) }); },
  });
  await transport.start(new AbortController().signal, async () => {});
  await Promise.race([
    recovered,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for poll recovery")), 7_000)),
  ]);
  assert.equal(pollCount, 2);
  assert.deepEqual(errorEvents, [{ event: "poll_conflict", status: 409 }]);
  await transport.stop();
});

test("Telegram polling stops retrying when bot credentials are unauthorized", async () => {
  let pollCount = 0;
  const errorEvents: Array<{ event: string; status?: number }> = [];
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/deleteWebhook")) return ok(true);
    if (String(input).endsWith("/getUpdates")) {
      pollCount++;
      return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
    }
    throw new Error("Unexpected Telegram endpoint.");
  };
  const transport = createTelegramHttpTransport({
    token,
    fetchImpl,
    onError(event, status) { errorEvents.push({ event, ...(status ? { status } : {}) }); },
  });
  await transport.start(new AbortController().signal, async () => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pollCount, 1);
  assert.deepEqual(errorEvents, [{ event: "poll_auth_failed", status: 401 }]);
  await transport.stop();
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


function waitForAbort(signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

test("Telegram polling reports a sanitized network failure kind", async () => {
  const events: Array<{ event: string; status?: number; kind?: string }> = [];
  let pollCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/deleteWebhook")) return ok(true);
    pollCount++;
    if (pollCount === 1) throw new Error("secret token and private network details");
    return waitForAbort(init?.signal);
  };
  const transport = createTelegramHttpTransport({
    token,
    fetchImpl,
    onError(event, status, kind) { events.push({ event, ...(status !== undefined ? { status } : {}), ...(kind ? { kind } : {}) }); },
  });
  await transport.start(new AbortController().signal, async () => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  await transport.stop();
  assert.equal(events[0]?.event, "poll_failed");
  assert.equal(events[0]?.kind, "network");
  assert.equal(events[0]?.status, undefined);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("Telegram polling reports invalid JSON separately from HTTP failures", async () => {
  const events: Array<{ event: string; status?: number; kind?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/deleteWebhook")) return ok(true);
    if (String(input).endsWith("/getUpdates")) return new Response("not-json", { status: 502 });
    return waitForAbort(init?.signal);
  };
  const transport = createTelegramHttpTransport({
    token,
    fetchImpl,
    onError(event, status, kind) { events.push({ event, ...(status !== undefined ? { status } : {}), ...(kind ? { kind } : {}) }); },
  });
  await transport.start(new AbortController().signal, async () => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  await transport.stop();
  assert.deepEqual(events[0], { event: "poll_failed", status: 502, kind: "invalid_json" });
});

test("Telegram polling reports HTTP errors with status", async () => {
  const events: Array<{ event: string; status?: number; kind?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/deleteWebhook")) return ok(true);
    if (String(input).endsWith("/getUpdates")) return new Response(JSON.stringify({ ok: false }), { status: 503 });
    return waitForAbort(init?.signal);
  };
  const transport = createTelegramHttpTransport({
    token,
    fetchImpl,
    onError(event, status, kind) { events.push({ event, ...(status !== undefined ? { status } : {}), ...(kind ? { kind } : {}) }); },
  });
  await transport.start(new AbortController().signal, async () => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  await transport.stop();
  assert.deepEqual(events[0], { event: "poll_failed", status: 503, kind: "http" });
});


test("Telegram polling classifies safe network failure categories without exposing provider details", async () => {
  const cases: Array<{ label: string; error: Error; expected: string }> = [
    { label: "DNS lookup", error: Object.assign(new Error("private resolver details"), { code: "ENOTFOUND" }), expected: "dns" },
    { label: "temporary DNS failure", error: Object.assign(new Error("private resolver details"), { code: "EAI_AGAIN" }), expected: "dns" },
    { label: "TLS certificate", error: Object.assign(new Error("private certificate details"), { code: "CERT_HAS_EXPIRED" }), expected: "tls" },
    { label: "connection reset", error: Object.assign(new Error("private socket details"), { code: "ECONNRESET" }), expected: "connection" },
    { label: "connection timeout", error: Object.assign(new Error("private timeout details"), { code: "ETIMEDOUT" }), expected: "timeout" },
    { label: "aborted request", error: Object.assign(new Error("private abort details"), { name: "AbortError" }), expected: "aborted" },
    { label: "nested Undici socket failure", error: Object.assign(new Error("fetch failed", { cause: Object.assign(new Error("private socket details"), { code: "UND_ERR_SOCKET" }) }), {}), expected: "connection" },
    { label: "nested self-signed TLS certificate", error: Object.assign(new Error("fetch failed", { cause: Object.assign(new Error("private certificate details"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) }), {}), expected: "tls" },
  ];

  for (const item of cases) {
    let resolveEvent!: (kind: string | undefined) => void;
    const event = new Promise<string | undefined>((resolve) => { resolveEvent = resolve; });
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/deleteWebhook")) return ok(true);
      throw item.error;
    };
    const transport = createTelegramHttpTransport({
      token,
      fetchImpl,
      onError(name, _status, kind) {
        if (name === "poll_failed") resolveEvent(kind);
      },
    });
    await transport.start(new AbortController().signal, async () => {});
    const actual = await Promise.race([
      event,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for " + item.label)), 1_000)),
    ]);
    assert.equal(actual, item.expected, item.label);
    await transport.stop();
  }
});
