import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ApprovalInbox } from "../agent/approval-inbox.js";
import { createSofiaApi } from "./server.js";

const route = {
  id: "approval-api-test", capabilities: ["fast" as const], costWeight: 1,
  latencyWeight: 1, qualityWeight: 1, healthy: true,
};
const ownerId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
const hash = createHash("sha256").update("the exact action").digest("hex");

test("approval API lists and decides only the authenticated owner's pending actions", async () => {
  const inbox = new ApprovalInbox();
  const waiting = inbox.request({
    principalId: ownerId("owner-key"), runId: "run-1", toolName: "browser.click",
    input: { selector: "#save" }, actionHash: hash, risk: "medium",
  });
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: {
      "owner-key": ["agent:read", "approval:read", "approval:decide"],
      "other-key": ["approval:read", "approval:decide"],
      "read-only-key": ["approval:read"],
    },
    approvalInbox: inbox,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const auth = (key: string) => ({ authorization: "Bearer " + key });
  try {
    const list = await fetch(base + "/v1/approvals", { headers: auth("owner-key") });
    assert.equal(list.status, 200);
    const payload = await list.json() as { approvals: Array<{ id: string; actionHash: string }> };
    assert.equal(payload.approvals.length, 1);
    const item = payload.approvals[0]!;
    const other = await fetch(base + "/v1/approvals", { headers: auth("other-key") });
    assert.equal((await other.json() as { approvals: unknown[] }).approvals.length, 0);

    const forbidden = await fetch(base + "/v1/approvals/" + item.id + "/decision", {
      method: "POST", headers: { ...auth("read-only-key"), "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", actionHash: hash }),
    });
    assert.equal(forbidden.status, 403);

    const wrongHash = await fetch(base + "/v1/approvals/" + item.id + "/decision", {
      method: "POST", headers: { ...auth("owner-key"), "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", actionHash: "0".repeat(64) }),
    });
    assert.equal(wrongHash.status, 409);

    const approved = await fetch(base + "/v1/approvals/" + item.id + "/decision", {
      method: "POST", headers: { ...auth("owner-key"), "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", actionHash: hash }),
    });
    assert.equal(approved.status, 200);
    assert.equal(await waiting, true);
    const replay = await fetch(base + "/v1/approvals/" + item.id + "/decision", {
      method: "POST", headers: { ...auth("owner-key"), "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", actionHash: hash }),
    });
    assert.equal(replay.status, 409);
  } finally {
    inbox.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
