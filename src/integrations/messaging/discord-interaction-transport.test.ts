import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createDiscordInteractionTransport } from "./discord-interaction-transport.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
const botToken = "BotToken_1234567890.abcdef-XYZ";
function signed(rawBody: Uint8Array, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signatureHex = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), privateKey).toString("hex");
  return { headers: { "x-signature-ed25519": signatureHex, "x-signature-timestamp": timestamp }, rawBody };
}
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

test("Discord transport verifies raw signatures, handles ping and dispatches slash commands", async () => {
  const sent: Array<{ url: string; init?: RequestInit }> = [];
  const transport = createDiscordInteractionTransport({
    publicKeyHex,
    botToken,
    fetchImpl: async (input, init) => {
      sent.push({ url: String(input), init });
      return response({ id: "987654321" });
    },
  });
  let resolveEvent!: (event: { content: string; id: string }) => void;
  const eventPromise = new Promise<{ content: string; id: string }>((resolve) => { resolveEvent = resolve; });
  await transport.start(new AbortController().signal, async (event) => resolveEvent({ content: event.content, id: event.id }));

  const ping = Buffer.from(JSON.stringify({ type: 1 }));
  assert.deepEqual(await transport.handleRequest(signed(ping)), { status: 200, body: { type: 1 } });

  const body = Buffer.from(JSON.stringify({
    type: 2, id: "interaction-1", channel_id: "123456789",
    member: { user: { id: "user-1", username: "tester" } },
    data: { name: "run", options: [{ name: "task", type: 3, value: "inspect repository" }] },
  }));
  assert.deepEqual(await transport.handleRequest(signed(body)), { status: 200, body: { type: 5 } });
  const event = await Promise.race([
    eventPromise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for Discord command")), 1_000)),
  ]);
  assert.deepEqual(event, { content: "/run inspect repository", id: "interaction-1" });

  assert.deepEqual(await transport.sendMessage("123456789", "Sofia accepted"), { messageId: "987654321" });
  assert.equal(sent[0].url, "https://discord.com/api/v10/channels/123456789/messages");
  assert.equal((sent[0].init?.headers as Record<string, string>).authorization, `Bot ${botToken}`);
  await transport.stop();
});

test("Discord transport rejects invalid signatures before parsing body", async () => {
  const transport = createDiscordInteractionTransport({ publicKeyHex, botToken });
  await transport.start(new AbortController().signal, async () => {});
  const result = await transport.handleRequest({
    headers: { "x-signature-ed25519": "00", "x-signature-timestamp": String(Math.floor(Date.now() / 1000)) },
    rawBody: Buffer.from("not json"),
  });
  assert.equal(result.status, 401);
  await transport.stop();
});

test("Discord transport rejects invalid configuration", () => {
  assert.throws(() => createDiscordInteractionTransport({ publicKeyHex: "bad", botToken }), /public key/);
  assert.throws(() => createDiscordInteractionTransport({ publicKeyHex, botToken: "bad" }), /token/);
});
