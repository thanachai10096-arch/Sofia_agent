import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDependencies } from "../agent/types.js";
import { createSofiaLocalApi } from "./local.js";

async function withServer(
  stateDirectory: string,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createSofiaLocalApi({
    provider: { generate: async () => ({ text: "Local Sofia response", assistantMessage: { role: "assistant", content: "Local Sofia response" } }) },
    router: {
      select: () => ({ id: "test-route", capabilities: ["fast"], costWeight: 0, latencyWeight: 0, qualityWeight: 1, healthy: true }),
      markUnhealthy: () => undefined,
    },
    reviewer: { review: async () => ({ approved: true, reason: "Test response accepted." }) },
  } as unknown as AgentDependencies, {
    apiKeys: { "local-test-token": ["agent:run", "agent:read"] },
  }, { stateDirectory });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function request(baseUrl: string, pathName: string, method = "GET", body?: unknown) {
  return fetch(baseUrl + pathName, {
    method,
    headers: {
      authorization: "Bearer local-test-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("local API factory persists conversations across server instances", async () => {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), "sofia-local-api-test-"));
  try {
    let conversationId = "";
    await withServer(stateDirectory, async (baseUrl) => {
      const created = await request(baseUrl, "/v1/conversations", "POST", { title: "Persisted local chat" });
      assert.equal(created.status, 201);
      const payload = await created.json() as { conversation: { id: string } };
      conversationId = payload.conversation.id;
    });

    await withServer(stateDirectory, async (baseUrl) => {
      const retrieved = await request(baseUrl, `/v1/conversations/${conversationId}`);
      assert.equal(retrieved.status, 200);
      const payload = await retrieved.json() as { conversation: { id: string; title: string } };
      assert.equal(payload.conversation.id, conversationId);
      assert.equal(payload.conversation.title, "Persisted local chat");
    });
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
