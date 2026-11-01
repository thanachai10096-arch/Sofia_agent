import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileRestoreSnapshotStore } from "./restore-snapshot-store.js";

const transactionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

test("restore snapshots persist across store instances and verify their digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-restore-snapshots-"));
  try {
    const first = new FileRestoreSnapshotStore(root);
    const bytes = Buffer.from("previous database state");
    const saved = await first.write(transactionId, "sessions", bytes);
    assert.equal(saved.byteLength, bytes.byteLength);
    assert.equal(saved.sha256.length, 64);

    const recovered = await new FileRestoreSnapshotStore(root).read(saved.ref, saved.sha256);
    assert.deepEqual(Buffer.from(recovered), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore snapshot store rejects tampering and malformed references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-restore-snapshots-tamper-"));
  try {
    const store = new FileRestoreSnapshotStore(root);
    const saved = await store.write(transactionId, "sessions", Buffer.from("original"));
    const file = path.join(root, ...saved.ref.split("/"));
    await writeFile(file, "tampered");
    await assert.rejects(store.read(saved.ref, saved.sha256), /digest verification failed/i);
    await assert.rejects(store.read("../outside.snapshot", saved.sha256), /reference is invalid/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore snapshot store does not overwrite a target snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-restore-snapshots-immutable-"));
  try {
    const store = new FileRestoreSnapshotStore(root);
    const first = await store.write(transactionId, "sessions", Buffer.from("original"));
    await assert.rejects(store.write(transactionId, "sessions", Buffer.from("replacement")));
    assert.deepEqual(Buffer.from(await store.read(first.ref, first.sha256)), Buffer.from("original"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore snapshot store rejects unsafe transaction and target identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-restore-snapshots-identity-"));
  try {
    const store = new FileRestoreSnapshotStore(root);
    await assert.rejects(store.write("../../outside", "sessions", Buffer.from("x")), /transaction ID/i);
    await assert.rejects(store.write(transactionId, "../sessions", Buffer.from("x")), /target name/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
