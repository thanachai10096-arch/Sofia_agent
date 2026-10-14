import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createSofiaApi } from "../src/api/server.js";
import type { AgentDependencies } from "../src/agent/types.js";
import type { SofiaBrain } from "../src/brain/executor.js";
import { createUserMemoryEntry, FileUserMemoryStore } from "../src/brain/user-memory.js";

function dependencies(): AgentDependencies {
  const fakeBrain = {
    runId: "api-e2e-run",
    run: async () => ({
      completed: true,
      summary: "Task completed and verified.",
      state: "completed",
      changedFiles: [],
      verification: { passed: true, checks: ["fake-e2e-check"] },
      usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 1, replans: 0 },
    }),
  } as unknown as SofiaBrain;

  return {
    provider: {} as AgentDependencies["provider"],
    router: { select: () => ({ id: "unused" }), markUnhealthy: () => undefined } as unknown as AgentDependencies["router"],
    reviewer: { review: async () => ({ approved: true, reason: "approved" }) },
    brainFactory: () => fakeBrain,
  };
}

test("API E2E authenticates, starts an async run, deduplicates retries, and isolates ownership", async () => {
  const server = createSofiaApi(dependencies(), {
    apiKeys: {
      "test-key": ["agent:run"],
      "other-key": ["agent:run"],
    },
    allowedOrigins: ["https://client.example"],
    requestTimeoutMs: 5_000,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const closeServer = async () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  try {
    const unauthorized = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "verify this API" }),
    });
    assert.equal(unauthorized.status, 401);

    const invalid = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ task: " " }),
    });
    assert.equal(invalid.status, 400);

    const headers = {
      authorization: "Bearer test-key",
      "content-type": "application/json",
      "idempotency-key": "stable-request-1",
      origin: "https://client.example",
    };
    const started = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: "verify a complete async lifecycle", async: true }),
    });
    assert.equal(started.status, 202);
    assert.equal(started.headers.get("access-control-allow-origin"), "https://client.example");
    const initial = await started.json() as { id: string; status: string };
    assert.ok(initial.id);

    const retry = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: "verify a complete async lifecycle", async: true }),
    });
    assert.equal(retry.status, 200);
    const repeated = await retry.json() as { id: string };
    assert.equal(repeated.id, initial.id);

    let observed: { id: string; status: string; result?: { output?: string } } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const poll = await fetch(`${baseUrl}/v1/agent/runs/${initial.id}`, {
        headers: { authorization: "Bearer test-key" },
      });
      assert.equal(poll.status, 200);
      observed = await poll.json() as typeof observed;
      if (observed?.status === "completed" || observed?.status === "failed") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(observed?.status, "completed");
    assert.equal(observed?.result?.output, "Task completed and verified.");

    const crossOwner = await fetch(`${baseUrl}/v1/agent/runs/${initial.id}`, {
      headers: { authorization: "Bearer other-key" },
    });
    assert.equal(crossOwner.status, 404);

    const disallowedOrigin = await fetch(`${baseUrl}/health`, {
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(disallowedOrigin.status, 200);
    assert.equal(disallowedOrigin.headers.get("access-control-allow-origin"), null);
  } finally {
    await closeServer();
  }
});


test("API memory routes enforce scopes and isolate each authenticated principal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sofia-api-memory-"));
  const memory = new FileUserMemoryStore(directory);
  const ownerId = createHash("sha256").update("test-key").digest("hex").slice(0, 32);
  try {
    const first = createUserMemoryEntry("preference", "Prefers concise Thai responses");
    await memory.save(ownerId, first);
    const deps = dependencies();
    deps.userMemory = memory;
    const server = createSofiaApi(deps, {
      apiKeys: {
        "test-key": ["agent:read", "agent:run"],
        "read-only": ["agent:read"],
        "other-key": ["agent:read", "agent:run"],
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = (key: string) => ({ authorization: `Bearer ${key}` });
    try {
      const listed = await fetch(`${baseUrl}/v1/memory`, { headers: headers("test-key") });
      assert.equal(listed.status, 200);
      const body = await listed.json() as { entries: Array<{ id: string; content: string }> };
      assert.equal(body.entries.length, 1);
      assert.equal(body.entries[0]?.content, "Prefers concise Thai responses");

      const search = await fetch(`${baseUrl}/v1/memory?q=concise`, { headers: headers("test-key") });
      assert.equal((await search.json() as { entries: unknown[] }).entries.length, 1);

      const forbiddenDelete = await fetch(`${baseUrl}/v1/memory/${first.id}`, {
        method: "DELETE", headers: headers("read-only"),
      });
      assert.equal(forbiddenDelete.status, 403);

      const isolated = await fetch(`${baseUrl}/v1/memory`, { headers: headers("other-key") });
      assert.deepEqual((await isolated.json() as { entries: unknown[] }).entries, []);

      const deleted = await fetch(`${baseUrl}/v1/memory/${first.id}`, {
        method: "DELETE", headers: headers("test-key"),
      });
      assert.equal(deleted.status, 200);
      assert.deepEqual(await memory.list(ownerId), []);

      await memory.save(ownerId, createUserMemoryEntry("fact", "Uses TypeScript"));
      const cleared = await fetch(`${baseUrl}/v1/memory`, {
        method: "DELETE", headers: headers("test-key"),
      });
      assert.equal(cleared.status, 200);
      assert.deepEqual(await memory.list(ownerId), []);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
