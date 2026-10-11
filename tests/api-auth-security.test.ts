import { test } from "node:test";
import assert from "node:assert/strict";
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
