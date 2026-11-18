import assert from "node:assert/strict";
import test from "node:test";
import { UpstashTelegramPollLeaseClient } from "./telegram-poll-lease-rest.js";

test("Upstash adapter sends SET NX PX using the JSON command API", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = new UpstashTelegramPollLeaseClient({
    url: "https://redis.example.test/",
    token: "rest-secret",
    fetchImpl: async (input, init) => {
      request = { url: String(input), init };
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    },
  });
  assert.equal(await client.set("lease:key", "owner", { NX: true, PX: 30_000 }), "OK");
  assert.equal(request?.url, "https://redis.example.test");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), ["SET", "lease:key", "owner", "NX", "PX", 30_000]);
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer rest-secret");
});

test("Upstash adapter sends EVAL with the key count and owner arguments", async () => {
  let body: unknown;
  const client = new UpstashTelegramPollLeaseClient({
    url: "https://redis.example.test",
    token: "secret",
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    },
  });
  assert.equal(await client.eval("return 1", { keys: ["lease:key"], arguments: ["owner", "30000"] }), 1);
  assert.deepEqual(body, ["EVAL", "return 1", 1, "lease:key", "owner", "30000"]);
});

test("Upstash adapter rejects insecure URLs and sanitizes provider failures", async () => {
  assert.throws(() => new UpstashTelegramPollLeaseClient({ url: "http://redis.example.test", token: "secret" }), /HTTPS/);
  const client = new UpstashTelegramPollLeaseClient({
    url: "https://redis.example.test",
    token: "secret",
    fetchImpl: async () => new Response(JSON.stringify({ error: "WRONGPASS private details" }), { status: 400 }),
  });
  await assert.rejects(() => client.set("key", "owner", { NX: true, PX: 30_000 }), /Redis command failed/);
});
