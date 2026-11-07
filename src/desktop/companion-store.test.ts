import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileDesktopCompanionStore } from "./companion-store.js";

test("persists only a token digest with owner-bound metadata and restrictive file modes", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-companion-store-"));
  try {
    const store = new FileDesktopCompanionStore(directory);
    const rawToken = "private-companion-token";
    const digest = createHash("sha256").update(rawToken).digest("hex");
    store.save({ ownerKeyId: "a".repeat(32), tokenDigest: digest, connectedAt: 100, lastSeenAt: 200 });
    const names = readdirSync(directory);
    assert.equal(names.length, 1);
    const filename = path.join(directory, names[0]!);
    const text = readFileSync(filename, "utf8");
    assert.equal(text.includes(rawToken), false);
    assert.deepEqual(store.loadAll(), [{
      ownerKeyId: "a".repeat(32), tokenDigest: digest, connectedAt: 100, lastSeenAt: 200,
    }]);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(filename).mode & 0o777, 0o600);
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    }
    store.delete("a".repeat(32));
    assert.equal(store.loadAll().length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects malformed records and prevents owner identity from being changed in a file", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-companion-store-"));
  try {
    const store = new FileDesktopCompanionStore(directory);
    store.save({ ownerKeyId: "b".repeat(32), tokenDigest: "c".repeat(64), connectedAt: 10, lastSeenAt: 10 });
    const filename = path.join(directory, readdirSync(directory)[0]!);
    const record = JSON.parse(readFileSync(filename, "utf8")) as Record<string, unknown>;
    record.ownerKeyId = "d".repeat(32);
    writeFileSync(filename, JSON.stringify(record));
    assert.deepEqual(store.loadAll(), []);
    assert.equal(readdirSync(directory).length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});



test("does not restore credentials atomically moved into the revoked tombstone namespace", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-companion-revoked-"));
  try {
    const store = new FileDesktopCompanionStore(directory);
    const ownerKeyId = "e".repeat(32);
    store.save({ ownerKeyId, tokenDigest: "f".repeat(64), connectedAt: 100, lastSeenAt: 100 });
    const live = path.join(directory, readdirSync(directory)[0]!);
    const tombstone = live + ".revoked";
    // Simulate a process stopping after the atomic revoke rename but before
    // best-effort tombstone cleanup.
    renameSync(live, tombstone);
    assert.deepEqual(store.loadAll(), []);
    assert.equal(readdirSync(directory).some((name) => name.endsWith(".json")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

