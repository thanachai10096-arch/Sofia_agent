import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FileSettlementJournal } from "./settlement-journal.js";

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
    await journal.acknowledgeCheckpoint("unknown-usage-run");
    assert.equal(await journal.hasUnresolved("unknown-usage-run"), true,
      "a durable brain snapshot cannot resolve unknown provider usage");

    const pendingClaim = await journal.claimRun("pending-run");
    await journal.begin("pending-run", { inputTokens: 10, outputTokens: 10 }, pendingClaim);
    await pendingClaim.release();
    await journal.acknowledgeCheckpoint("pending-run");
    assert.equal(await journal.hasUnresolved("pending-run"), true,
      "a checkpoint cannot resolve a provider attempt without a settlement record");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
