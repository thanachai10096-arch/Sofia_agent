import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopCompanionClient } from "./companion-client.js";
import type { DesktopCompanionCredentialStore } from "./companion-client.js";
import type { DesktopHostDriver } from "./types.js";

function credentials(): DesktopCompanionCredentialStore & { value: string | null } {
  return {
    value: null,
    async get() { return this.value; },
    async set(token) { this.value = token; },
    async delete() { this.value = null; },
  };
}

function driver(calls: string[]): DesktopHostDriver {
  return {
    async captureScreen() { return { mimeType: "image/png", data: new Uint8Array(), width: 1, height: 1 }; },
    async launchApplication(applicationId) { calls.push("launch:" + applicationId); return { launched: true, applicationId }; },
    async click() { calls.push("click"); },
    async typeText(text) { calls.push("type:" + text); },
    async pressKey(key) { calls.push("key:" + key); },
  };
}

test("Desktop Companion pairs without persisting the Sofia API key and executes approved commands", async () => {
  const store = credentials();
  const calls: string[] = [];
  const requests: Array<{ url: string; authorization?: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    requests.push({ url, authorization: headers?.authorization, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/connect")) return new Response(JSON.stringify({ token: "c".repeat(43), connectedAt: 123 }), { status: 201 });
    if (url.endsWith("/commands")) return new Response(JSON.stringify({
      command: { id: "00000000-0000-4000-8000-000000000001", createdAt: 123, action: { kind: "input.type", text: "hello" } },
    }), { status: 200 });
    return new Response(JSON.stringify({ completed: true }), { status: 200 });
  };
  const client = createDesktopCompanionClient({
    apiBaseUrl: "https://sofia.example.com",
    credentials: store,
    driver: driver(calls),
    allowedCapabilities: ["input:control"],
    requestApproval: async () => true,
    fetchImpl,
  });
  assert.deepEqual(await client.pair("owner-api-secret"), { connectedAt: 123 });
  assert.equal(store.value, "c".repeat(43));
  assert.equal(requests[0]?.authorization, "Bearer owner-api-secret");
  assert.equal(await client.pollOnce(), true);
  assert.deepEqual(calls, ["type:hello"]);
  assert.deepEqual(JSON.parse(requests[2]!.body!), { result: { ok: true } });
  assert.equal(requests.some((item) => item.body?.includes("owner-api-secret")), false);
});

test("Desktop Companion reports approval denial without performing the local action", async () => {
  const store = credentials();
  store.value = "d".repeat(43);
  const calls: string[] = [];
  let completion: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (String(_input).endsWith("/commands")) return new Response(JSON.stringify({
      command: { id: "00000000-0000-4000-8000-000000000002", createdAt: 123, action: { kind: "input.key", key: "Enter" } },
    }), { status: 200 });
    completion = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ completed: true }), { status: 200 });
  };
  const client = createDesktopCompanionClient({
    apiBaseUrl: "http://127.0.0.1:3000",
    credentials: store,
    driver: driver(calls),
    allowedCapabilities: ["input:control"],
    requestApproval: async () => false,
    fetchImpl,
  });
  assert.equal(await client.pollOnce(), true);
  assert.deepEqual(calls, []);
  assert.equal(typeof completion?.error, "string");
  assert.match(completion?.error as string, /denied/);
});

test("Desktop Companion clears revoked credentials and rejects insecure remote HTTP URLs", async () => {
  const store = credentials();
  store.value = "e".repeat(43);
  const client = createDesktopCompanionClient({
    apiBaseUrl: "https://sofia.example.com",
    credentials: store,
    driver: driver([]),
    allowedCapabilities: [],
    requestApproval: async () => true,
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  await assert.rejects(client.pollOnce(), /pairing was revoked/);
  assert.equal(store.value, null);
  assert.throws(() => createDesktopCompanionClient({
    apiBaseUrl: "http://sofia.example.com",
    credentials: store,
    driver: driver([]),
    allowedCapabilities: [],
    requestApproval: async () => true,
  }), /requires HTTPS/);
});

test("stopping keeps the OS credential; explicit disconnect revokes server pairing and clears it", async () => {
  const store = credentials();
  store.value = "f".repeat(43);
  const calls: Array<{ url: string; authorization?: string }> = [];
  const client = createDesktopCompanionClient({
    apiBaseUrl: "https://sofia.example.com",
    credentials: store,
    driver: driver([]),
    allowedCapabilities: [],
    requestApproval: async () => false,
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      return new Response(JSON.stringify({ disconnected: true }), { status: 200 });
    },
  });
  client.stop();
  assert.equal(store.value, "f".repeat(43));
  await client.disconnect("owner-api-secret");
  assert.equal(store.value, null);
  assert.equal(calls[0]?.url, "https://sofia.example.com/v1/desktop/companion/disconnect");
  assert.equal(calls[0]?.authorization, "Bearer owner-api-secret");
});
