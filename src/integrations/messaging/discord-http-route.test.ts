import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DiscordInteractionTransport } from "./discord-interaction-transport.js";
import { handleDiscordInteractionHttpRequest } from "./discord-http-route.js";

function request(body: Uint8Array, method = "POST") {
  return Object.assign(Readable.from([Buffer.from(body)]), {
    method,
    headers: {
      "x-signature-ed25519": "signed-value",
      "x-signature-timestamp": "1234567890",
    },
  }) as unknown as IncomingMessage;
}
function responseCapture() {
  const capture: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const response = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) { capture.status = status; capture.headers = headers; return response; },
    end(body?: string) { capture.body = body; return response; },
    destroy() {},
  } as unknown as ServerResponse;
  return { capture, response };
}

test("Discord HTTP route preserves raw body and signature headers", async () => {
  const raw = Buffer.from('{"type":1}');
  let observed: { rawBody: Uint8Array; signature?: string } | undefined;
  const transport = {
    async start() {},
    async sendMessage() { return { messageId: "1" }; },
    async stop() {},
    async handleRequest(input: { rawBody: Uint8Array; headers: { "x-signature-ed25519"?: string } }) {
      observed = { rawBody: input.rawBody, signature: input.headers["x-signature-ed25519"] };
      return { status: 200 as const, body: { type: 1 } };
    },
  } as unknown as DiscordInteractionTransport;
  const req = request(raw);
  const { capture, response } = responseCapture();
  await handleDiscordInteractionHttpRequest(req, response, transport);
  assert.equal(capture.status, 200);
  assert.equal(Buffer.from(observed?.rawBody ?? []).toString("utf8"), raw.toString("utf8"));
  assert.equal(observed?.signature, "signed-value");
  assert.equal(capture.headers?.["x-content-type-options"], "nosniff");
});

test("Discord HTTP route rejects oversized bodies before signature processing", async () => {
  let called = false;
  const transport = {
    async start() {}, async sendMessage() { return { messageId: "1" }; }, async stop() {},
    async handleRequest() { called = true; return { status: 200 as const, body: {} }; },
  } as unknown as DiscordInteractionTransport;
  const { capture, response } = responseCapture();
  await handleDiscordInteractionHttpRequest(request(Buffer.from("a".repeat(32))), response, transport, 16);
  assert.equal(capture.status, 413);
  assert.equal(called, false);
});

test("Discord HTTP route rejects non-POST requests", async () => {
  const transport = {
    async start() {}, async sendMessage() { return { messageId: "1" }; }, async stop() {},
    async handleRequest() { throw new Error("must not be called"); },
  } as unknown as DiscordInteractionTransport;
  const { capture, response } = responseCapture();
  await handleDiscordInteractionHttpRequest(request(Buffer.from("{}"), "GET"), response, transport);
  assert.equal(capture.status, 405);
});

test("Discord HTTP route converts unexpected transport errors to a generic 503", async () => {
  const transport = {
    async start() {}, async sendMessage() { return { messageId: "1" }; }, async stop() {},
    async handleRequest() { throw new Error("sensitive token should not leak"); },
  } as unknown as DiscordInteractionTransport;
  const { capture, response } = responseCapture();
  await handleDiscordInteractionHttpRequest(request(Buffer.from("{}")), response, transport);
  assert.equal(capture.status, 503);
  assert.equal(capture.body, JSON.stringify({ error: "messaging_transport_unavailable" }));
  assert.equal(capture.body?.includes("sensitive"), false);
});
