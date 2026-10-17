import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSofiaApi } from "../src/api/server.js";
import type { AgentDependencies } from "../src/agent/types.js";

test("API authentication rejects inherited object keys as bearer tokens", async () => {
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { "valid-test-key": ["agent:run"] },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    for (const token of ["constructor", "toString", "__proto__"]) {
      const response = await fetch(base + "/v1/usage", {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 401, `token ${token} must be rejected`);
    }

    const valid = await fetch(base + "/v1/usage", {
      headers: { authorization: "Bearer valid-test-key" },
    });
    assert.equal(valid.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("API refuses run creation when the API key lacks agent:run scope", async () => {
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { "read-only-key": ["agent:read"] },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: "Bearer read-only-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "must be denied" }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden", requiredScope: "agent:run" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("API refuses streaming run creation when the API key lacks agent:run scope", async () => {
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { "read-only-key": ["agent:read"] },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/runs/stream`, {
      method: "POST",
      headers: { authorization: "Bearer read-only-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "must be denied" }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden", requiredScope: "agent:run" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});



test("API requires agent:read or agent:run to inspect a run", async () => {
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { "desktop-only-key": ["desktop:discover"] },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/runs/not-owned`, {
      headers: { authorization: "Bearer desktop-only-key" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden", requiredScope: "agent:read" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("API requires agent:run to cancel a run even when the key can read runs", async () => {
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { "read-only-key": ["agent:read"] },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/runs/not-owned`, {
      method: "DELETE",
      headers: { authorization: "Bearer read-only-key" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden", requiredScope: "agent:run" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("API permits agent:run scope to inspect its own run status", async () => {
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { "run-key": ["agent:run"] },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/runs/not-found`, {
      headers: { authorization: "Bearer run-key" },
    });
    assert.equal(response.status, 404, "run-capable keys can read run status; this ID simply does not exist");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("API authenticates SHA-256 hashed keys without storing the plaintext token in config", async () => {
  const token = "hash-only-test-token";
  const hash = createHash("sha256").update(token).digest("hex");
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: {},
    apiKeyHashes: { [hash]: ["agent:run"] },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/usage", {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(response.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("API throttles repeated authentication failures per client address", async () => {
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { "valid-test-key": ["agent:run"] },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = "http://127.0.0.1:" + address.port + "/v1/usage";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(url, { headers: { authorization: "Bearer invalid-key" } });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(url, { headers: { authorization: "Bearer valid-test-key" } });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "authentication_rate_limited" });
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
