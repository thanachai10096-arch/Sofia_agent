import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { FileSettlementJournal } from "./settlement-journal.js";



class FailingDirectorySyncJournal extends FileSettlementJournal {
  failNextSync = false;

  protected override async syncDirectory(): Promise<void> {
    if (this.failNextSync) {
      this.failNextSync = false;
      throw new Error("injected directory sync failure");
    }
    await super.syncDirectory();
  }
}

test("claim directory-sync failure preserves the claim and blocks another worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-claim-sync-failure-"));
  try {
    const failing = new FailingDirectorySyncJournal("workspace", root);
    failing.failNextSync = true;
    await assert.rejects(failing.claimRun("claim-sync-failure"), /injected directory sync failure/);

    const otherWorker = new FileSettlementJournal("workspace", root);
    await assert.rejects(otherWorker.claimRun("claim-sync-failure"), /already claimed/,
      "a claim with uncertain directory durability must remain fail-closed");
    const inspection = await otherWorker.inspectRun("claim-sync-failure");
    assert.equal(inspection.claim, "active");
    assert.equal(inspection.unresolved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new journal directory-sync failure keeps evidence and does not release its claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-journal-sync-failure-"));
  try {
    const journal = new FailingDirectorySyncJournal("workspace", root);
    const claim = await journal.claimRun("journal-sync-failure");
    journal.failNextSync = true;

    await assert.rejects(
      journal.begin("journal-sync-failure", { inputTokens: 3, outputTokens: 4 }, claim),
      /injected directory sync failure/,
    );
    assert.equal(await journal.hasUnresolved("journal-sync-failure"), true,
      "the started-attempt evidence must remain unresolved after sync failure");
    await assert.rejects(
      new FileSettlementJournal("workspace", root).claimRun("journal-sync-failure"),
      /already claimed/,
      "the caller's claim remains held until explicit reconciliation");
    await claim.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settlement journal records only bounded accounting metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-"));
  try {
    const journal = new FileSettlementJournal("workspace-secret", root);
    const claim = await journal.claimRun("run-private");
    const attempt = await journal.begin("run-private", { inputTokens: 12, outputTokens: 34 }, claim);
    assert.equal(await journal.hasUnresolved("run-private"), true);
    await journal.settle("run-private", attempt, { inputTokens: 8, outputTokens: 5 }, claim);
    await claim.release();
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

test("settlement rejects fabricated and duplicate attempt IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-attempt-validation-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("attempt-validation-run");
    const attempt = await journal.begin("attempt-validation-run", { inputTokens: 4, outputTokens: 8 }, claim);

    await assert.rejects(
      journal.settle("attempt-validation-run", { id: "not-started" }, { inputTokens: 1, outputTokens: 1 }, claim),
      /exactly one pending Started event/,
      "a caller must not be able to invent settlement evidence without a durable Started event",
    );

    await journal.settle("attempt-validation-run", attempt, { inputTokens: 2, outputTokens: 3 }, claim);
    await assert.rejects(
      journal.settle("attempt-validation-run", attempt, { inputTokens: 2, outputTokens: 3 }, claim),
      /exactly one pending Started event/,
      "a settlement must not be appended twice for the same provider attempt",
    );

    assert.equal(await journal.hasUnresolved("attempt-validation-run"), true,
      "the known settlement must remain uncheckpointed, not be overwritten by duplicate evidence");
    const inspection = await journal.inspectRun("attempt-validation-run");
    assert.equal(inspection.startedAttempts, 1);
    assert.equal(inspection.settledAttempts, 1);
    assert.equal(inspection.journal, "unresolved");
    await claim.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settlement validates attempts across multiple JSONL events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-multi-attempt-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("multi-attempt-run");

    const first = await journal.begin("multi-attempt-run", { inputTokens: 5, outputTokens: 7 }, claim);
    await journal.settle("multi-attempt-run", first, { inputTokens: 4, outputTokens: 3 }, claim);

    const second = await journal.begin("multi-attempt-run", { inputTokens: 6, outputTokens: 8 }, claim);
    await journal.settle("multi-attempt-run", second, { inputTokens: 5, outputTokens: 4 }, claim);

    const inspection = await journal.inspectRun("multi-attempt-run");
    assert.equal(inspection.startedAttempts, 2);
    assert.equal(inspection.settledAttempts, 2);
    assert.equal(inspection.journal, "unresolved",
      "known settlements remain unresolved until a durable checkpoint is acknowledged");
    assert.equal(inspection.unresolved, true);
    await claim.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settlement recovery inspection is read-only and reports active claims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-inspect-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("inspect-run");
    const attempt = await journal.begin("inspect-run", { inputTokens: 10, outputTokens: 20 }, claim);

    const active = await journal.inspectRun("inspect-run");
    assert.equal(active.claim, "active");
    assert.equal(active.journal, "unresolved");
    assert.equal(active.startedAttempts, 1);
    assert.equal(active.settledAttempts, 0);
    assert.equal(active.unresolved, true);
    assert.ok(active.owner?.pid);
    assert.ok(active.owner?.hostname);
    assert.equal("token" in (active.owner ?? {}), false, "inspection must not expose the lock token");
    await assert.rejects(journal.claimRun("inspect-run"), /already claimed/);

    await journal.settle("inspect-run", attempt, { inputTokens: 8, outputTokens: 9 }, claim);
    await claim.release();
    const settled = await journal.inspectRun("inspect-run");
    assert.equal(settled.claim, "absent");
    assert.equal(settled.journal, "unresolved", "known settlement remains pending until checkpoint");
    assert.equal(settled.startedAttempts, 1);
    assert.equal(settled.settledAttempts, 1);
    assert.equal(settled.unknownUsageAttempts, 0);
    assert.equal(settled.unresolved, true);

    await journal.acknowledgeCheckpoint("inspect-run");
    const resolved = await journal.inspectRun("inspect-run");
    assert.equal(resolved.journal, "resolved");
    assert.equal(resolved.checkpoints, 1);
    assert.equal(resolved.unresolved, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settlement recovery inspection classifies malformed journal evidence as corrupt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-inspect-corrupt-"));
  try {
    const namespace = "workspace";
    const runId = "corrupt-inspect-run";
    const directory = path.join(root, createHash("sha256").update(namespace).digest("hex"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const journalFile = path.join(directory, createHash("sha256").update(runId).digest("hex") + ".jsonl");
    await writeFile(journalFile, '{"version":1,"type":"started"\n', { mode: 0o600 });
    const lockFile = journalFile + ".lock";
    await writeFile(lockFile, '{"version":1,"pid":', { mode: 0o600 });
    const journal = new FileSettlementJournal(namespace, root);
    const inspection = await journal.inspectRun(runId);
    assert.equal(inspection.claim, "invalid", "malformed claim metadata must be reported, not trusted");
    assert.equal(inspection.journal, "corrupt");
    assert.equal(inspection.unresolved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncated trailing JSONL write is corrupt and cannot be checkpointed or deleted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-truncated-tail-"));
  try {
    const namespace = "workspace";
    const runId = "truncated-tail-run";
    const directory = path.join(root, createHash("sha256").update(namespace).digest("hex"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const journalFile = path.join(directory, createHash("sha256").update(runId).digest("hex") + ".jsonl");
    const validStarted = JSON.stringify({
      version: 1, type: "started", attemptId: "attempt-1",
      at: new Date().toISOString(), maxInputTokens: 10, maxOutputTokens: 10,
    });
    const validSettled = JSON.stringify({
      version: 1, type: "settled", attemptId: "attempt-1",
      at: new Date().toISOString(), usageKnown: true,
      usage: { inputTokens: 4, outputTokens: 3 },
    });
    // Simulate process termination while appending the next JSONL event.
    await writeFile(journalFile, validStarted + "\n" + validSettled + "\n" + '{"version":1,"type":"checkpoint"', { mode: 0o600 });

    const journal = new FileSettlementJournal(namespace, root);
    const inspection = await journal.inspectRun(runId);
    assert.equal(inspection.journal, "corrupt");
    assert.equal(inspection.unresolved, true);
    assert.equal(await journal.hasUnresolved(runId), true);
    await assert.rejects(journal.acknowledgeCheckpoint(runId), /corrupt settlement evidence/);
    await assert.rejects(journal.deleteRun(runId), /Cannot delete unresolved settlement evidence/);
    assert.equal(await readFile(journalFile, "utf8"), validStarted + "\n" + validSettled + "\n" + '{"version":1,"type":"checkpoint"',
      "recovery checks must preserve the original partial-write evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unresolved or corrupt settlement records fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("run-1");
    const attempt = await journal.begin("run-1", { inputTokens: 1, outputTokens: 2 }, claim);
    assert.equal(await journal.hasUnresolved("run-1"), true);
    await journal.settle("run-1", attempt, { inputTokens: 1, outputTokens: 1 }, claim);
    await claim.release();
    assert.equal(await journal.hasUnresolved("run-1"), true);
    await assert.rejects(journal.deleteRun("run-1"), /Cannot delete unresolved settlement evidence/);
    await journal.acknowledgeCheckpoint("run-1");
    assert.equal(await journal.hasUnresolved("run-1"), false);
    await journal.deleteRun("run-1");
    assert.equal(await journal.hasUnresolved("run-1"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("settlement run claims serialize independent journal instances and release by owner token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-claim-"));
  try {
    const first = new FileSettlementJournal("shared-workspace", root);
    const second = new FileSettlementJournal("shared-workspace", root);
    const outcomes = await Promise.allSettled([
      first.claimRun("same-run"),
      second.claimRun("same-run"),
    ]);
    const acquired = outcomes.filter((item) => item.status === "fulfilled");
    const rejected = outcomes.filter((item) => item.status === "rejected");
    assert.equal(acquired.length, 1, "exactly one independent journal instance may claim a run");
    assert.equal(rejected.length, 1, "the competing worker must fail closed");
    assert.ok(rejected[0]!.status === "rejected" && rejected[0]!.reason instanceof Error);

    const claim = acquired[0]!.status === "fulfilled" ? acquired[0]!.value : undefined;
    assert.ok(claim);
    await claim.release();

    const afterRelease = await second.claimRun("same-run");
    await afterRelease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent settlement claim releases are idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-claim-release-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("concurrent-release-run");
    await Promise.all([claim.release(), claim.release(), claim.release()]);
    const next = await journal.claimRun("concurrent-release-run");
    await next.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settlement claim release refuses to unlink a replacement owner's lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-claim-owner-change-"));
  try {
    const { createHash } = await import("node:crypto");
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("owner-change-run");
    const directory = path.join(root, createHash("sha256").update("workspace").digest("hex"));
    const lockFile = path.join(directory, createHash("sha256").update("owner-change-run").digest("hex") + ".jsonl.lock");
    const replacement = JSON.stringify({
      version: 1,
      token: "replacement-owner-token",
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    }) + "\n";

    await rm(lockFile);
    await writeFile(lockFile, replacement, { encoding: "utf8", mode: 0o600 });

    await assert.rejects(claim.release(), /ownership changed/);
    assert.equal(await readFile(lockFile, "utf8"), replacement,
      "release must preserve a lock whose owner token no longer matches");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settlement run claim remains fail-closed while an existing claim is present", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-claim-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("run-1");
    await assert.rejects(journal.claimRun("run-1"), /already claimed/);
    await claim.release();
    const next = await journal.claimRun("run-1");
    await next.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("settlement run claim excludes a separate Node.js worker process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-process-"));
  const journal = new FileSettlementJournal("shared-process-workspace", root);
  const moduleUrl = new URL("./settlement-journal.ts", import.meta.url).href;
  const parentClaim = await journal.claimRun("same-process-run");

  const runChild = (expectBlocked: boolean) => {
    const script = `
      import { FileSettlementJournal, SettlementRunClaimedError } from ${JSON.stringify(moduleUrl)};
      const journal = new FileSettlementJournal("shared-process-workspace", ${JSON.stringify(root)});
      try {
        const claim = await journal.claimRun("same-process-run");
        await claim.release();
        if (${expectBlocked}) process.exitCode = 2;
      } catch (error) {
        if (${expectBlocked} && error instanceof SettlementRunClaimedError) process.exitCode = 0;
        else { console.error(error); process.exitCode = 3; }
      }
    `;
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });
  };

  try {
    const blocked = runChild(true);
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
    await parentClaim.release();
    const allowed = runChild(false);
    assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  } finally {
    await parentClaim.release();
    await rm(root, { recursive: true, force: true });
  }
});


test("abrupt worker process exit preserves claim and blocks replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-worker-crash-"));
  try {
    const moduleUrl = new URL("./settlement-journal.ts", import.meta.url).href;
    const script = `
      import { FileSettlementJournal } from ${JSON.stringify(moduleUrl)};
      const journal = new FileSettlementJournal("crashed-worker-workspace", ${JSON.stringify(root)});
      const claim = await journal.claimRun("crashed-worker-run");
      await journal.begin("crashed-worker-run", { inputTokens: 12, outputTokens: 16 }, claim);
      // Simulate abrupt process termination: deliberately do not release the claim.
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);

    const restartedWorker = new FileSettlementJournal("crashed-worker-workspace", root);
    const inspection = await restartedWorker.inspectRun("crashed-worker-run");
    assert.equal(inspection.claim, "active");
    assert.equal(inspection.journal, "unresolved");
    assert.equal(inspection.startedAttempts, 1);
    assert.equal(inspection.settledAttempts, 0);
    assert.equal(inspection.unresolved, true);
    await assert.rejects(
      restartedWorker.claimRun("crashed-worker-run"),
      /already claimed/,
      "a restarted worker must not replay a possibly billed provider attempt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal writes reject missing, released, or mismatched run claims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-claim-validation-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("run-a");
    await assert.rejects(
      journal.begin("run-a", { inputTokens: 1, outputTokens: 1 }, {
        assertRun() { throw new Error("invalid claim"); },
        async release() {},
      }),
      /invalid claim/,
    );
    const attempt = await journal.begin("run-a", { inputTokens: 1, outputTokens: 1 }, claim);
    await assert.rejects(
      journal.settle("run-b", attempt, { inputTokens: 1, outputTokens: 1 }, claim),
      /Invalid settlement journal settlement/,
    );
    await claim.release();
    await assert.rejects(
      journal.settle("run-a", attempt, { inputTokens: 1, outputTokens: 1 }, claim),
      /claim is missing, released, or belongs to another run/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("journal cleanup refuses to erase corrupt settlement evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-corrupt-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("corrupt-run");
    const attempt = await journal.begin("corrupt-run", { inputTokens: 1, outputTokens: 1 }, claim);
    await claim.release();
    const { readdir, writeFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const directory = path.join(root, createHash("sha256").update("workspace").digest("hex"));
    const file = path.join(directory, createHash("sha256").update("corrupt-run").digest("hex") + ".jsonl");
    await writeFile(file, "{corrupt journal record}\\n", "utf8");
    assert.equal(await journal.hasUnresolved("corrupt-run"), true);
    await assert.rejects(journal.deleteRun("corrupt-run"), /Cannot delete unresolved settlement evidence/);
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".jsonl")), true);
    void attempt;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint cannot clear an unsettled or unknown-usage provider attempt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-ambiguous-checkpoint-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);

    const unknownClaim = await journal.claimRun("unknown-usage-run");
    const unknownAttempt = await journal.begin("unknown-usage-run", { inputTokens: 10, outputTokens: 10 }, unknownClaim);
    await journal.settle("unknown-usage-run", unknownAttempt, undefined, unknownClaim);
    await unknownClaim.release();
    assert.equal(await journal.hasUnresolved("unknown-usage-run"), true);
    await assert.rejects(
      journal.acknowledgeCheckpoint("unknown-usage-run"),
      /pending or ambiguous/,
      "a checkpoint must not be appended when provider usage is unknown",
    );
    assert.equal(await journal.hasUnresolved("unknown-usage-run"), true,
      "a durable brain snapshot cannot resolve unknown provider usage");

    const pendingClaim = await journal.claimRun("pending-run");
    await journal.begin("pending-run", { inputTokens: 10, outputTokens: 10 }, pendingClaim);
    await pendingClaim.release();
    await assert.rejects(
      journal.acknowledgeCheckpoint("pending-run"),
      /pending or ambiguous/,
      "a checkpoint must not be appended while a provider attempt is unsettled",
    );
    assert.equal(await journal.hasUnresolved("pending-run"), true,
      "a checkpoint cannot resolve a provider attempt without a settlement record");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal refuses a symlinked namespace directory and does not write through it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-outside-"));
  try {
    const { createHash } = await import("node:crypto");
    const namespaceDirectory = path.join(root, createHash("sha256").update("workspace").digest("hex"));
    await symlink(outside, namespaceDirectory, "dir");
    const journal = new FileSettlementJournal("workspace", root);
    await assert.rejects(journal.claimRun("symlink-run"), /must be a real directory/);
    assert.deepEqual(await (await import("node:fs/promises")).readdir(outside), []);
  } catch (error) {
    if (error && typeof error === "object" &&
        ["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(String((error as NodeJS.ErrnoException).code))) {
      t.skip("This platform does not permit creating directory symlinks in the test environment");
      return;
    }
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("journal append refuses a symlink record without modifying its target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-file-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-target-"));
  try {
    const { createHash } = await import("node:crypto");
    const directory = path.join(root, createHash("sha256").update("workspace").digest("hex"));
    await (await import("node:fs/promises")).mkdir(directory, { recursive: true });
    const target = path.join(outside, "target.jsonl");
    await writeFile(target, "preserve-this-file\n", "utf8");
    const record = path.join(directory, createHash("sha256").update("symlink-run").digest("hex") + ".jsonl");
    await symlink(target, record, "file");
    const journal = new FileSettlementJournal("workspace", root);
    const claim = await journal.claimRun("symlink-run");
    try {
      await assert.rejects(
        journal.begin("symlink-run", { inputTokens: 1, outputTokens: 1 }, claim),
      );
    } finally {
      await claim.release();
    }
    assert.equal(await readFile(target, "utf8"), "preserve-this-file\n");
  } catch (error) {
    if (error && typeof error === "object" &&
        ["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(String((error as NodeJS.ErrnoException).code))) {
      t.skip("This platform does not permit creating file symlinks in the test environment");
      return;
    }
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("settlement journal treats symlinked evidence as unresolved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-symlink-"));
  const external = path.join(root, "external.jsonl");
  const namespace = "symlink-workspace";
  const runId = "symlink-run";
  const directory = path.join(root, createHash("sha256").update(namespace).digest("hex"));
  const journalFile = path.join(directory, createHash("sha256").update(runId).digest("hex") + ".jsonl");
  try {
    const journal = new FileSettlementJournal(namespace, root);
    const claim = await journal.claimRun(runId);
    await claim.release();
    await writeFile(external, "", "utf8");
    await symlink(external, journalFile);
    assert.equal(await journal.hasUnresolved(runId), true,
      "a symlink must not be followed as an empty, resolved journal");
    const inspection = await journal.inspectRun(runId);
    assert.equal(inspection.journal, "corrupt");
    assert.equal(inspection.unresolved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settlement claim release refuses to follow a replacement symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-settlement-claim-symlink-"));
  try {
    const namespace = "workspace";
    const runId = "claim-symlink-run";
    const journal = new FileSettlementJournal(namespace, root);
    const claim = await journal.claimRun(runId);
    const directory = path.join(root, createHash("sha256").update(namespace).digest("hex"));
    const lockFile = path.join(directory, createHash("sha256").update(runId).digest("hex") + ".jsonl.lock");
    const target = path.join(root, "external-lock-target");
    await writeFile(target, JSON.stringify({
      version: 1, token: "replacement-owner-token", pid: process.pid,
      hostname: os.hostname(), createdAt: new Date().toISOString(),
    }) + "\n", "utf8");
    await rm(lockFile);
    await symlink(target, lockFile);

    await assert.rejects(claim.release(), /path is invalid/);
    assert.equal(await readlink(lockFile), target,
      "release must preserve the replacement symlink rather than follow or unlink it");
    assert.match(await readFile(target, "utf8"), /replacement-owner-token/);
    const inspection = await journal.inspectRun(runId);
    assert.equal(inspection.claim, "invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
