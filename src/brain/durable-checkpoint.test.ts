import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import { DurableCheckpointManager } from "./durable-checkpoint.js";

function emptyRuntime(): WorkspaceRuntime {
  return {
    platform: "linux",
    cwd: async () => "/workspace",
    readFile: async () => "",
    writeFile: async () => undefined,
    listFiles: async () => [],
    search: async () => [],
    run: async () => ({ stdout: "", stderr: "git unavailable", code: 1 }),
    git: async () => ({ stdout: "", stderr: "git unavailable", code: 1 }),
  };
}

test("durable checkpoints are isolated by principal namespace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-checkpoint-isolation-"));
  const ownerOne = new DurableCheckpointManager(emptyRuntime(), "principal:key-one", root);
  const ownerTwo = new DurableCheckpointManager(emptyRuntime(), "principal:key-two", root);
  const signal = new AbortController().signal;

  try {
    const checkpoint = await ownerOne.create(signal);
    await assert.rejects(
      ownerTwo.rollback(checkpoint.id, signal),
      /Unknown checkpoint/,
    );
    const restored = await ownerOne.rollback(checkpoint.id, signal);
    assert.deepEqual(restored.restoredFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable checkpoint loading rejects path-like identifiers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-checkpoint-path-"));
  const manager = new DurableCheckpointManager(emptyRuntime(), "principal:key-one", root);
  try {
    await assert.rejects(
      manager.rollback("../outside", new AbortController().signal),
      /Unknown checkpoint/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
