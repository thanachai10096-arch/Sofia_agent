import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EncryptedUserModelProfileStore } from "./profile-store.js";
import { SofiaModelGateway } from "./gateway.js";
import type { ModelRoute } from "./types.js";

test("model gateway selects a profile only for its authenticated principal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-profile-routing-test-"));
  const store = new EncryptedUserModelProfileStore(path.join(directory, "profiles.json"), Buffer.alloc(32, 3).toString("base64"));
  const requests: Array<{ url: string; authorization: string; model: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), authorization: headers.get("authorization") ?? "", model: body.model });
    return new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await store.set("alice", {
      provider: "openai-compatible",
      model: "alice-private-model",
      apiKey: "alice-provider-key-12345",
      baseUrl: "https://api.openai.com/v1/",
    });
    const gateway = new SofiaModelGateway({
      fast: { baseUrl: "https://global-provider.example/v1/", apiKey: "global-provider-key", model: "global-default-model" },
    }, store);
    const route: ModelRoute = {
      id: "fast", providerId: "fast", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 1, healthy: true,
    };
    await gateway.generate({ task: "hello", kind: "general", step: 1, principalId: "alice" }, route);
    await gateway.generate({ task: "hello", kind: "general", step: 1, principalId: "bob" }, route);
    assert.deepEqual(requests.map(request => request.model), ["alice-private-model", "global-default-model"]);
    assert.equal(requests[0]?.authorization, "Bearer alice-provider-key-12345");
    assert.equal(requests[1]?.authorization, "Bearer global-provider-key");
    assert.equal(requests[0]?.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(route.healthy, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
