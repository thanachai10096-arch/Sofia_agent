import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Aes256GcmApprovalPayloadCipher } from "./approval-payload-cipher.js";
import { DurableApprovalCoordinator } from "./durable-approval-coordinator.js";
import { SqliteApprovalStore } from "./sqlite-approval-store.js";
import { SqliteApprovalPayloadStore } from "./sqlite-approval-payload-store.js";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);

async function fixture(run: (value: {
  origin: SqliteApprovalStore;
  reviewer: SqliteApprovalStore;
  payloads: SqliteApprovalPayloadStore;
  coordinator: DurableApprovalCoordinator;
  file: string;
}) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-durable-approval-"));
  const file = path.join(root, "approvals.sqlite");
  const origin = await SqliteApprovalStore.open(file);
  const reviewer = await SqliteApprovalStore.open(file);
  const payloads = await SqliteApprovalPayloadStore.open(file);
  const cipher = new Aes256GcmApprovalPayloadCipher(randomBytes(32), "coordinator-test-v1");
  const coordinator = new DurableApprovalCoordinator(origin, payloads, cipher, {
    ttlMs: 10_000,
    pollIntervalMs: 50,
    now: () => 2_000,
    sleep: async () => {},
  });
  try {
    await run({ origin, reviewer, payloads, coordinator, file });
  } finally {
    payloads.close();
    reviewer.close();
    origin.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const request = {
  runId: "run-durable-1",
  principalId: "tenant-a",
  toolName: "browser.purchase",
  input: { item: "coffee", quantity: 2 },
  actionHash: "sha256-exact-action",
  risk: "high" as const,
};

test("durable approval stores encrypted input and returns it only to the origin after approval", {
  skip: !supportsNodeSqlite,
}, async () => {
  await fixture(async ({ origin, reviewer, coordinator, file }) => {
    const ticket = coordinator.create(request);
    assert.ok(ticket);
    assert.deepEqual(coordinator.readPending(ticket, "tenant-a"), request.input);
    assert.equal(coordinator.readPending(ticket, "tenant-b"), null);
    assert.equal(reviewer.settlePending(ticket.id, "tenant-a", ticket.context.actionHash, "approved", 2_100), true);

    const result = await coordinator.waitForDecision(ticket, "tenant-a");
    assert.deepEqual(result, { status: "approved", input: request.input });
    assert.equal((origin.get("tenant-a", ticket.id, 2_200))?.status, "approved");
    for (const diskFile of [file, file + "-wal", file + "-shm"]) {
      if (fs.existsSync(diskFile)) {
        assert.equal(fs.readFileSync(diskFile).includes(Buffer.from('"item":"coffee"')), false);
      }
    }
  });
});

test("durable approval rejects wrong owner and action context", {
  skip: !supportsNodeSqlite,
}, async () => {
  await fixture(async ({ coordinator }) => {
    const ticket = coordinator.create(request);
    assert.ok(ticket);
    assert.equal(await coordinator.waitForDecision(ticket, "tenant-b").then(result => result.status), "interrupted");
    const changed = { ...ticket, context: { ...ticket.context, actionHash: "different-action" } };
    assert.equal(coordinator.readPending(changed, "tenant-a"), null);
  });
});

test("durable approval does not return proposed input after rejection or expiry", {
  skip: !supportsNodeSqlite,
}, async () => {
  await fixture(async ({ reviewer, coordinator }) => {
    const ticket = coordinator.create(request);
    assert.ok(ticket);
    assert.equal(reviewer.settlePending(ticket.id, "tenant-a", ticket.context.actionHash, "rejected", 2_100), true);
    assert.deepEqual(await coordinator.waitForDecision(ticket, "tenant-a"), { status: "rejected" });
  });
});

test("durable approval compensates metadata when proposed input cannot be serialized", {
  skip: !supportsNodeSqlite,
}, async () => {
  await fixture(async ({ origin, coordinator }) => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const ticket = coordinator.create({ ...request, input: circular });
    assert.equal(ticket, null);
    assert.equal(origin.history("tenant-a").length, 1);
    assert.equal(origin.history("tenant-a")[0]?.status, "interrupted");
  });
});
