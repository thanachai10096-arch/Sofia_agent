import { test } from "node:test";
import assert from "node:assert/strict";
import { createSofiaApi } from "../src/api/server.js";
import type { AgentDependencies } from "../src/agent/types.js";

test("learning diagnostics requires authentication and the admin scope", async () => {
  const server = createSofiaApi({
    learningDiagnostics: () => ({ totals: { skills: 0, attempts: 0 } }),
  } as unknown as AgentDependencies, {
    apiKeys: {
      reader_key: ["agent:run"],
      admin_key: ["agent:run", "security:admin"],
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/learning/diagnostics`;

  try {
    const anonymous = await fetch(endpoint);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: "unauthorized" });

    const reader = await fetch(endpoint, {
      headers: { authorization: "Bearer reader_key" },
    });
    assert.equal(reader.status, 403);
    assert.deepEqual(await reader.json(), { error: "forbidden" });

    const admin = await fetch(endpoint, {
      headers: { authorization: "Bearer admin_key" },
    });
    assert.equal(admin.status, 200);
    assert.deepEqual(await admin.json(), { totals: { skills: 0, attempts: 0 } });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("learning diagnostics fails closed when the diagnostics provider is missing", async () => {
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { admin_key: ["security:admin"] },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/learning/diagnostics`, {
      headers: { authorization: "Bearer admin_key" },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "learning_diagnostics_unavailable" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
