import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ApprovalInbox } from "./approval-inbox.js";

const actionHash = createHash("sha256").update("immutable action").digest("hex");
const request = (principalId = "owner-a") => ({
  principalId,
  runId: "run-123",
  toolName: "browser.click",
  input: { selector: "#confirm", password: "do-not-display" },
  actionHash,
  risk: "medium" as const,
});

test("approval inbox exposes owner-scoped requests and approves only the exact action hash", async () => {
  const inbox = new ApprovalInbox();
  const waiting = inbox.request(request());
  const [item] = inbox.list("owner-a");
  assert.ok(item);
  assert.equal(inbox.list("owner-b").length, 0);
  assert.equal(JSON.stringify(item.input).includes("do-not-display"), false);
  assert.equal(inbox.decide("owner-b", item.id, actionHash, "approve"), false);
  assert.equal(inbox.decide("owner-a", item.id, "0".repeat(64), "approve"), false);
  assert.equal(inbox.list("owner-a").length, 1);
  assert.equal(inbox.decide("owner-a", item.id, actionHash, "approve"), true);
  assert.equal(await waiting, true);
  assert.equal(inbox.decide("owner-a", item.id, actionHash, "approve"), false);
  inbox.close();
});

test("approval inbox denies a request and fails closed when the broker closes", async () => {
  const inbox = new ApprovalInbox();
  const denied = inbox.request(request());
  const [first] = inbox.list("owner-a");
  assert.ok(first);
  assert.equal(inbox.decide("owner-a", first.id, actionHash, "deny"), true);
  assert.equal(await denied, false);

  const interrupted = inbox.request(request());
  inbox.close();
  assert.equal(await interrupted, false);
  assert.equal(inbox.list("owner-a").length, 0);
});

test("approval inbox expires pending requests and rejects missing principals", async () => {
  const inbox = new ApprovalInbox({ ttlMs: 1_000 });
  assert.equal(await inbox.request({ ...request(), principalId: undefined }), false);
  const waiting = inbox.request(request());
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(await waiting, false);
  assert.equal(inbox.list("owner-a").length, 0);
  inbox.close();
});
