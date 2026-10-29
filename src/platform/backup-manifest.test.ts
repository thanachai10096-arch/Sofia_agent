import test from "node:test";
import assert from "node:assert/strict";
import {
  createBackupManifest,
  parseBackupManifestJson,
  serializeBackupManifest,
  validateBackupManifest,
  verifyBackupFiles,
} from "./backup-manifest.js";

const createdAt = "2026-10-29T04:00:00.000Z";

test("backup manifest is deterministic and verifies exact file bytes", () => {
  const files = [
    { path: "sessions/sessions.sqlite", content: Buffer.from("sqlite bytes") },
    { path: "memory/user.json", content: Buffer.from("{\"ok\":true}") },
  ];
  const manifest = createBackupManifest(files, createdAt);
  assert.deepEqual(manifest.entries.map((entry) => entry.path), [
    "memory/user.json",
    "sessions/sessions.sqlite",
  ]);
  const result = verifyBackupFiles(manifest, new Map(files.map((file) => [file.path, file.content])));
  assert.equal(result.valid, true);
  assert.equal(result.verifiedFiles, 2);
  assert.equal(result.verifiedBytes, files.reduce((sum, file) => sum + file.content.byteLength, 0));
});

test("manifest rejects traversal, absolute, Windows and duplicate paths", () => {
  for (const path of ["../secret", "a/../../secret", "/etc/passwd", "C:/secret", "a\\b", "a//b", "."]) {
    assert.throws(() => createBackupManifest([{ path, content: Buffer.from("x") }], createdAt), /safe relative/);
  }
  assert.throws(() => createBackupManifest([
    { path: "memory/a.json", content: Buffer.from("one") },
    { path: "memory/a.json", content: Buffer.from("two") },
  ], createdAt), /unique/);
});

test("verification detects missing, unexpected, changed and truncated files", () => {
  const files = [
    { path: "a.txt", content: Buffer.from("alpha") },
    { path: "b.txt", content: Buffer.from("bravo") },
  ];
  const manifest = createBackupManifest(files, createdAt);
  const changed = verifyBackupFiles(manifest, new Map([
    ["a.txt", Buffer.from("altered")],
    ["extra.txt", Buffer.from("unexpected")],
  ]));
  assert.equal(changed.valid, false);
  assert.ok(changed.errors.some((error) => error.includes("Size mismatch") || error.includes("Checksum mismatch")));
  assert.ok(changed.errors.some((error) => error.includes("Missing backup file")));
  assert.ok(changed.errors.some((error) => error.includes("Unexpected backup file")));
});

test("untrusted manifests reject unsupported versions, invalid hashes and duplicate entries", () => {
  const manifest = createBackupManifest([{ path: "a.txt", content: Buffer.from("x") }], createdAt);
  assert.throws(() => validateBackupManifest({ ...manifest, formatVersion: 99 }), /Unsupported/);
  assert.throws(() => validateBackupManifest({
    ...manifest, entries: [{ ...manifest.entries[0], sha256: "not-a-hash" }],
  }), /SHA-256/);
  assert.throws(() => validateBackupManifest({
    ...manifest, entries: [...manifest.entries, ...manifest.entries],
  }), /duplicate/);
});

test("invalid manifests fail closed without verifying files", () => {
  const result = verifyBackupFiles({ format: "unknown" }, new Map());
  assert.equal(result.valid, false);
  assert.equal(result.verifiedFiles, 0);
  assert.equal(result.errors.length, 1);
});

test("manifest JSON round-trips deterministically and rejects malformed or oversized input", () => {
  const manifest = createBackupManifest([
    { path: "z.txt", content: Buffer.from("last") },
    { path: "a.txt", content: Buffer.from("first") },
  ], createdAt);
  const json = serializeBackupManifest(manifest);
  assert.equal(json, serializeBackupManifest(parseBackupManifestJson(json)));
  assert.deepEqual(parseBackupManifestJson(json).entries.map((entry) => entry.path), ["a.txt", "z.txt"]);
  assert.throws(() => parseBackupManifestJson("{"), /malformed/);
  assert.throws(() => parseBackupManifestJson(" ".repeat(16 * 1024 * 1024 + 1)), /maximum allowed size/);
  assert.throws(() => serializeBackupManifest({ format: "wrong" }), /Invalid Sofia backup manifest format/);
});
