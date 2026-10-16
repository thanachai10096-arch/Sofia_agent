import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileRunRecordStore } from "./run-record-store.js";

test("run store reports failed durable writes and recovers its write queue", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sofia-run-store-test-"));
  const store = new FileRunRecordStore(directory);
  const id = randomUUID();
  const now = Date.now();
  const record = {
    id,
    status: "queued" as const,
    createdAt: now,
    updatedAt: now,
    ownerKeyId: "a".repeat(32),
    desktopCapabilities: [],
    events: [],
  };

  try {
    mkdirSync(path.join(directory, id + ".json"));
    await assert.rejects(store.save(record));
    rmSync(path.join(directory, id + ".json"), { recursive: true, force: true });
    await store.save(record);
    assert.equal(store.loadAllSync().some((item) => item.id === id && item.status === "queued"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
