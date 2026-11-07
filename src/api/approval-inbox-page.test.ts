import assert from "node:assert/strict";
import test from "node:test";
import { createSofiaApi } from "./server.js";

test("mobile approval inbox is served without exposing API credentials", async () => {
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => { throw new Error("unused"); }, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, { apiKeys: { "test-key": ["approval:read", "approval:decide"] } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/approvals`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /Sofia Approval Inbox/);
    assert.match(html, /type="password"/);
    assert.match(html, /not saved to browser storage/);
    assert.doesNotMatch(html, /test-key/);
    assert.match(html, /\/v1\/approvals/);
    assert.match(html, /actionHash/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
