import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSettlementJournal } from "./settlement-journal.js";

test("settlement journal records only bounded accounting metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-"));
  try {
    const journal = new FileSettlementJournal("workspace-secret", root);
    const attempt = await journal.begin("run-private", { inputTokens: 12, outputTokens: 34 });
    assert.equal(await journal.hasUnresolved("run-private"), true);
    await journal.settle("run-private", attempt, { inputTokens: 8, outputTokens: 5 });
    assert.equal(await journal.hasUnresolved("run-private"), true);
    await journal.acknowledgeCheckpoint("run-private");
    assert.equal(await journal.hasUnresolved("run-private"), false);

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(path.join(root, (await import("node:crypto")).createHash("sha256").update("workspace-secret").digest("hex")));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(root, (await import("node:crypto")).createHash("sha256").update("workspace-secret").digest("hex"), files[0]!), "utf8");
    assert.match(raw, /"maxInputTokens":12/);
    assert.doesNotMatch(raw, /workspace-secret|run-private|prompt|api[_-]?key|provider-name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unresolved or corrupt settlement records fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    await journal.begin("run-1", { inputTokens: 1, outputTokens: 2 });
    assert.equal(await journal.hasUnresolved("run-1"), true);
    await journal.deleteRun("run-1");
    assert.equal(await journal.hasUnresolved("run-1"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
