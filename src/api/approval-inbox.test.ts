import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileApprovalAuditStore } from "../agent/approval-audit-store.js";
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
  const auditDirectory = mkdtempSync(path.join(os.tmpdir(), "sofia-approval-api-"));
  const auditStore = new FileApprovalAuditStore(auditDirectory);
  const inbox = new ApprovalInbox({ auditStore });
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
    approvalAuditStore: auditStore,
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
    const audit = await fetch(base + "/v1/approvals/audit", { headers: auth("owner-key") });
    assert.equal(audit.status, 200);
    assert.deepEqual((await audit.json() as { events: Array<{ status: string }> }).events.map((event) => event.status), ["requested"]);
    const otherAudit = await fetch(base + "/v1/approvals/audit", { headers: auth("other-key") });
    assert.equal((await otherAudit.json() as { events: unknown[] }).events.length, 0);
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
    const decidedAudit = await fetch(base + "/v1/approvals/audit?limit=10", { headers: auth("owner-key") });
    assert.deepEqual((await decidedAudit.json() as { events: Array<{ status: string }> }).events.map((event) => event.status), ["approved", "requested"]);
    const replay = await fetch(base + "/v1/approvals/" + item.id + "/decision", {
      method: "POST", headers: { ...auth("owner-key"), "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", actionHash: hash }),
    });
    assert.equal(replay.status, 409);
  } finally {
    inbox.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(auditDirectory, { recursive: true, force: true });
  }
});
