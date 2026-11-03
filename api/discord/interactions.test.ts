import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import discordInteractions from "./interactions.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
type EnvSnapshot = Record<string, string | undefined>;
const names = [
  "DISCORD_PUBLIC_KEY", "DISCORD_ALLOWED_USER_IDS", "DISCORD_ALLOWED_CHANNEL_IDS",
  "DISCORD_COMMAND_NAME", "VERCEL_URL", "SOFIA_INTERNAL_API_KEY",
] as const;
const originalEnv: EnvSnapshot = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;

function restoreEnv(): void {
  for (const name of names) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = originalFetch;
}

afterEach(restoreEnv);

function configure(): void {
  process.env.DISCORD_PUBLIC_KEY = publicKeyHex;
  process.env.DISCORD_ALLOWED_USER_IDS = "123456789012345678";
  process.env.DISCORD_ALLOWED_CHANNEL_IDS = "234567890123456789";
  process.env.DISCORD_COMMAND_NAME = "run";
  process.env.VERCEL_URL = "sofia-preview.example";
  process.env.SOFIA_INTERNAL_API_KEY = "test-internal-key";
}

function signedHeaders(rawBody: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody, "utf8")]), privateKey).toString("hex");
  return { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp };
}

async function invoke(rawBody: string, headers: Record<string, string> = signedHeaders(rawBody)): Promise<{
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> {
  const req = new PassThrough() as PassThrough & {
    method: string;
    headers: Record<string, string>;
  };
  req.method = "POST";
  req.headers = headers;
  const responseHeaders: Record<string, string> = {};
  let responseBody = "";
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) { responseHeaders[name.toLowerCase()] = value; },
    end(value?: string) { responseBody = value ?? ""; },
  };
  const promise = discordInteractions(req as never, res as never);
  req.end(rawBody);
  await promise;
  return { status: res.statusCode, body: JSON.parse(responseBody || "{}"), headers: responseHeaders };
}

function interaction(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 2,
    id: "345678901234567890",
    application_id: "456789012345678901",
    token: "interaction-token",
    channel_id: "234567890123456789",
    data: { name: "run", options: [{ name: "task", value: "Check Sofia status" }] },
    user: { id: "123456789012345678", bot: false },
    ...overrides,
  });
}

describe("Vercel Discord interactions endpoint", () => {
  it("rejects requests with an invalid Ed25519 signature", async () => {
    configure();
    const rawBody = interaction();
    const result = await invoke(rawBody, {
      "x-signature-ed25519": "0".repeat(128),
      "x-signature-timestamp": Date.now().toString(),
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "invalid_discord_signature");
  });

  it("answers the Discord PING handshake after signature verification", async () => {
    configure();
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("must not call"); }) as typeof fetch;
    const result = await invoke(JSON.stringify({ type: 1 }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { type: 1 });
    assert.equal(called, false);
  });

  it("denies users outside the explicit allowlist without calling Sofia", async () => {
    configure();
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("must not call"); }) as typeof fetch;
    const rawBody = interaction({ user: { id: "987654321098765432", bot: false } });
    const result = await invoke(rawBody);
    assert.equal(result.status, 200);
    assert.equal((result.body.data as Record<string, unknown>).content, "Access denied.");
    assert.equal(called, false);
  });

  it("forwards a signed allowlisted task using the dedicated upstream credential", async () => {
    configure();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: "run-456", status: "queued" }), { status: 202 });
    }) as typeof fetch;
    const result = await invoke(interaction());
    assert.equal(result.status, 200);
    assert.match(String((result.body.data as Record<string, unknown>).content), /run-456/);
    const apiCall = calls[0];
    assert.equal(apiCall?.url, "https://sofia-preview.example/api/v1/agent/runs");
    assert.equal(new Headers(apiCall?.init?.headers).get("authorization"), "Bearer test-internal-key");
    assert.match(new Headers(apiCall?.init?.headers).get("idempotency-key") ?? "", /^discord_[a-f0-9]{64}$/);
    assert.equal(JSON.parse(String(apiCall?.init?.body)).task, "Check Sofia status");
  });
});
