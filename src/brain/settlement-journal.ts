import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { sofiaStateDirectory } from "../platform/state-directory.js";
import type { TokenUsage } from "./token-budget.js";

type JournalEvent =
  | { version: 1; type: "checkpoint"; at: string }
  | { version: 1; type: "started"; attemptId: string; at: string; maxInputTokens: number; maxOutputTokens: number }
  | { version: 1; type: "settled"; attemptId: string; at: string; usageKnown: boolean; usage?: TokenUsage };

export interface SettlementAttempt {
  id: string;
}

export class SettlementRunClaimedError extends Error {
  constructor() {
    super("Settlement run is already claimed by another worker");
    this.name = "SettlementRunClaimedError";
  }
}

export interface SettlementRunInspection {
  claim: "absent" | "active" | "invalid";
  owner?: { pid: number; hostname: string; createdAt: string };
  journal: "missing" | "resolved" | "unresolved" | "corrupt";
  startedAttempts: number;
  settledAttempts: number;
  unknownUsageAttempts: number;
  checkpoints: number;
  unresolved: boolean;
}

export interface SettlementRunClaim {
  assertRun(runId: string): void;
  release(): Promise<void>;
}

/**
 * Minimal durable inference accounting journal.
 *
 * It deliberately excludes prompts, task text, provider replies, credentials,
 * and provider/model/route names. An unresolved start is treated as ambiguous:
 * callers must not replay that provider request automatically.
 */
export class FileSettlementJournal {
  private readonly directory: string;

  constructor(namespace: string, root = sofiaStateDirectory("settlements")) {
    this.directory = path.join(root, createHash("sha256").update(namespace).digest("hex"));
  }

  private file(runId: string): string {
    return path.join(this.directory, createHash("sha256").update(runId).digest("hex") + ".jsonl");
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Settlement journal directory must be a real directory, not a symbolic link");
    }
    // Do not chmod through a path that could be replaced after lstat. Open the
    // directory itself without following symlinks, verify its inode, then
    // tighten permissions through the descriptor.
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const directoryOnly = fsConstants.O_DIRECTORY ?? 0;
    const handle = await fs.open(this.directory, fsConstants.O_RDONLY | directoryOnly | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino) {
        throw new Error("Settlement journal directory changed during validation");
      }
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }

  /**
   * Persist directory-entry changes on POSIX filesystems. Windows does not
   * expose a portable directory-fsync contract through Node's FileHandle API;
   * that platform limitation is documented rather than silently overstated.
   */
  private async syncDirectory(): Promise<void> {
    if (process.platform === "win32") return;
    const directoryOnly = fsConstants.O_DIRECTORY ?? 0;
    const handle = await fs.open(this.directory, fsConstants.O_RDONLY | directoryOnly);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Atomically claims one run on a cooperating local filesystem.
   *
   * The exclusive-create operation is the cross-process boundary: only one
   * worker can own the run while it checks the journal and performs inference.
   * Claims are deliberately never reclaimed based on age. A crashed worker
   * leaves a fail-closed claim for operator reconciliation rather than risking
   * a second billable provider request. Multi-host workers need a transactional
   * shared store; this file claim is not a distributed lease.
   */
  async claimRun(runId: string): Promise<SettlementRunClaim> {
    if (!runId) throw new Error("Invalid settlement journal run claim");
    await this.ensureDirectory();

    const lockFile = this.file(runId) + ".lock";
    const token = randomUUID();
    const owner = {
      version: 1,
      token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    };
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SettlementRunClaimedError();
      }
      throw error;
    }

    try {
      await handle.writeFile(JSON.stringify(owner) + "\n", "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      // We created the path exclusively. Remove it only if its token still
      // identifies this acquisition; never unlink a replacement owner's claim.
      try {
        const current = JSON.parse(await fs.readFile(lockFile, "utf8")) as { token?: unknown };
        if (current.token === token) await fs.unlink(lockFile);
      } catch {
        // Preserve the original write error; an uncertain claim remains fail-closed.
      }
      throw error;
    } finally {
      await handle?.close();
    }

    // The claim file's contents are synced above; persist its directory entry
    // before any provider attempt can be admitted. If this fails, leave the
    // claim in place and fail closed.
    await this.syncDirectory();

    let released = false;
    let releaseInFlight: Promise<void> | undefined;
    return {
      assertRun: (claimedRunId: string) => {
        if (released || claimedRunId !== runId) {
          throw new Error("Settlement run claim is missing, released, or belongs to another run");
        }
      },
      release: async () => {
        if (released) return;
        // Concurrent callers share one unlink operation. Without this guard,
        // two idempotent releases could both read the token and race to unlink,
        // making the second caller fail with ENOENT after the first succeeds.
        if (!releaseInFlight) {
          releaseInFlight = (async () => {
            let current: { token?: unknown };
            let lockInfo: Awaited<ReturnType<typeof fs.lstat>>;
            try {
              lockInfo = await fs.lstat(lockFile);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                released = true;
                return;
              }
              throw error;
            }
            if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
              throw new Error("Settlement run claim path is invalid; refusing to release it");
            }
            const noFollow = fsConstants.O_NOFOLLOW ?? 0;
            const lockHandle = await fs.open(lockFile, fsConstants.O_RDONLY | noFollow);
            try {
              const opened = await lockHandle.stat();
              if (!opened.isFile() || opened.dev !== lockInfo.dev || opened.ino !== lockInfo.ino) {
                throw new Error("Settlement run claim changed during release; refusing to release it");
              }
              current = JSON.parse(await lockHandle.readFile("utf8")) as { token?: unknown };
            } finally {
              await lockHandle.close();
            }
            if (current.token !== token) {
              throw new Error("Settlement run claim ownership changed; refusing to release another worker's claim");
            }
            // Re-check the path identity immediately before unlink. The claim
            // token alone is insufficient if the lock path was replaced by a
            // symlink or another inode after it was read.
            const beforeUnlink = await fs.lstat(lockFile);
            if (beforeUnlink.isSymbolicLink() || !beforeUnlink.isFile() ||
                beforeUnlink.dev !== lockInfo.dev || beforeUnlink.ino !== lockInfo.ino) {
              throw new Error("Settlement run claim changed before release; refusing to unlink it");
            }
            await fs.unlink(lockFile);
            // If this fails, report the uncertainty. A resurrected claim after
            // a crash is safe (fail-closed), whereas claiming release was durable is not.
            await this.syncDirectory();
            released = true;
          })();
        }
        try {
          await releaseInFlight;
        } catch (error) {
          // Permit an explicit retry after a transient filesystem error.
          releaseInFlight = undefined;
          throw error;
        }
      },
    };
  }

  private async append(runId: string, event: JournalEvent): Promise<void> {
    await this.ensureDirectory();
    const file = this.file(runId);
    let existingInfo: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      existingInfo = await fs.lstat(file);
      if (existingInfo.isSymbolicLink() || !existingInfo.isFile()) {
        throw new Error("Settlement journal record must be a regular file, not a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // O_NOFOLLOW closes the symlink lstat/open race on platforms that expose
    // it. If a record already existed, also require the opened descriptor to
    // identify that same inode; otherwise a concurrent path replacement could
    // redirect an append to a different regular file.
    // The lstat check above still rejects pre-existing symlinks elsewhere.
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = await fs.open(
      file,
      fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | noFollow,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || (existingInfo &&
          (info.dev !== existingInfo.dev || info.ino !== existingInfo.ino))) {
        throw new Error("Settlement journal record changed during validation");
      }
      // chmod the opened inode rather than resolving the path a second time.
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(event) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!existingInfo) {
      // A new journal record needs both durable contents and a durable name.
      // On failure the run claim remains held and begin() rejects.
      await this.syncDirectory();
    }
  }

  async begin(runId: string, maximum: TokenUsage, claim: SettlementRunClaim): Promise<SettlementAttempt> {
    if (!runId) throw new Error("Invalid settlement journal attempt");
    claim.assertRun(runId);
    if (!Number.isSafeInteger(maximum.inputTokens) || maximum.inputTokens < 0 ||
        !Number.isSafeInteger(maximum.outputTokens) || maximum.outputTokens < 0) {
      throw new Error("Invalid settlement journal attempt");
    }
    const id = randomUUID();
    await this.append(runId, {
      version: 1,
      type: "started",
      attemptId: id,
      at: new Date().toISOString(),
      maxInputTokens: maximum.inputTokens,
      maxOutputTokens: maximum.outputTokens,
    });
    return { id };
  }

  async settle(runId: string, attempt: SettlementAttempt, usage: TokenUsage | undefined, claim: SettlementRunClaim): Promise<void> {
    if (!runId || !attempt.id) throw new Error("Invalid settlement journal settlement");
    claim.assertRun(runId);
    const usageKnown = usage !== undefined &&
      Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 &&
      Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0;
    await this.append(runId, {
      version: 1,
      type: "settled",
      attemptId: attempt.id,
      at: new Date().toISOString(),
      usageKnown,
      ...(usageKnown ? { usage } : {}),
    });
  }

  /**
   * Read-only recovery diagnostics. This never acquires, releases, or removes
   * a claim and never changes journal evidence. The lock token is deliberately
   * omitted from the returned owner metadata.
   */
  async inspectRun(runId: string): Promise<SettlementRunInspection> {
    if (!runId) throw new Error("Invalid settlement journal inspection");
    const journalFile = this.file(runId);
    const lockFile = journalFile + ".lock";
    let claim: SettlementRunInspection["claim"] = "absent";
    let owner: SettlementRunInspection["owner"];

    try {
      const lockInfo = await fs.lstat(lockFile);
      if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
        claim = "invalid";
      } else {
        const noFollow = fsConstants.O_NOFOLLOW ?? 0;
        const handle = await fs.open(lockFile, fsConstants.O_RDONLY | noFollow);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== lockInfo.dev || opened.ino !== lockInfo.ino) {
            claim = "invalid";
          } else {
            const raw: unknown = JSON.parse(await handle.readFile("utf8"));
            if (!raw || typeof raw !== "object") {
              claim = "invalid";
            } else {
              const record = raw as Record<string, unknown>;
              const valid = record.version === 1 &&
                typeof record.token === "string" && record.token.length > 0 &&
                Number.isSafeInteger(record.pid) && (record.pid as number) > 0 &&
                typeof record.hostname === "string" && record.hostname.length > 0 &&
                typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt));
              if (!valid) {
                claim = "invalid";
              } else {
                claim = "active";
                owner = {
                  pid: record.pid as number,
                  hostname: record.hostname as string,
                  createdAt: record.createdAt as string,
                };
              }
            }
          }
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        claim = "invalid";
      } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") claim = "invalid";
        else throw error;
      }
    }

    let source: string;
    try {
      const info = await fs.lstat(journalFile);
      if (info.isSymbolicLink() || !info.isFile()) {
        return { claim, ...(owner ? { owner } : {}), journal: "corrupt", startedAttempts: 0, settledAttempts: 0, unknownUsageAttempts: 0, checkpoints: 0, unresolved: true };
      }
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      const handle = await fs.open(journalFile, fsConstants.O_RDONLY | noFollow);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
          return { claim, ...(owner ? { owner } : {}), journal: "corrupt", startedAttempts: 0, settledAttempts: 0, unknownUsageAttempts: 0, checkpoints: 0, unresolved: true };
        }
        source = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { claim, ...(owner ? { owner } : {}), journal: "missing", startedAttempts: 0, settledAttempts: 0, unknownUsageAttempts: 0, checkpoints: 0, unresolved: false };
      }
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        return { claim: "invalid", journal: "corrupt", startedAttempts: 0, settledAttempts: 0, unknownUsageAttempts: 0, checkpoints: 0, unresolved: true };
      }
      throw error;
    }

    let startedAttempts = 0;
    let settledAttempts = 0;
    let unknownUsageAttempts = 0;
    let checkpoints = 0;
    let corrupt = false;
    for (const line of source.split("\n")) {
      if (!line) continue;
      let raw: unknown;
      try { raw = JSON.parse(line) as unknown; } catch { corrupt = true; break; }
      if (!raw || typeof raw !== "object") { corrupt = true; break; }
      const event = raw as Record<string, unknown>;
      if (event.version !== 1 || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))) {
        corrupt = true;
        break;
      }
      if (event.type === "started" &&
          typeof event.attemptId === "string" && event.attemptId.length > 0 &&
          Number.isSafeInteger(event.maxInputTokens) && (event.maxInputTokens as number) >= 0 &&
          Number.isSafeInteger(event.maxOutputTokens) && (event.maxOutputTokens as number) >= 0) {
        startedAttempts += 1;
      } else if (event.type === "settled" &&
          typeof event.attemptId === "string" && event.attemptId.length > 0 &&
          typeof event.usageKnown === "boolean") {
        settledAttempts += 1;
        if (!event.usageKnown) unknownUsageAttempts += 1;
      } else if (event.type === "checkpoint") {
        checkpoints += 1;
      } else {
        corrupt = true;
        break;
      }
    }

    const unresolved = corrupt || await this.hasUnresolved(runId);
    return {
      claim,
      ...(owner ? { owner } : {}),
      journal: corrupt ? "corrupt" : unresolved ? "unresolved" : "resolved",
      startedAttempts,
      settledAttempts,
      unknownUsageAttempts,
      checkpoints,
      unresolved,
    };
  }

  async hasUnresolved(runId: string): Promise<boolean> {
    const journalFile = this.file(runId);
    let source: string;
    try {
      const info = await fs.lstat(journalFile);
      // Never follow a replaced or attacker-controlled journal path. Treat
      // non-regular files as ambiguous evidence so callers fail closed.
      if (info.isSymbolicLink() || !info.isFile()) return true;
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      const handle = await fs.open(journalFile, fsConstants.O_RDONLY | noFollow);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return true;
        source = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return true;
      throw error;
    }

    // A checkpoint may acknowledge only known, matched settlements. It must
    // never erase an attempt whose provider outcome or usage is ambiguous.
    const pendingAttempts = new Set<string>();
    let uncheckpointedKnownSettlement = false;
    let ambiguousEvidence = false;

    for (const line of source.split("\n")) {
      if (!line) continue;
      let raw: unknown;
      try { raw = JSON.parse(line) as unknown; }
      catch { return true; }
      if (!raw || typeof raw !== "object") return true;
      const event = raw as Record<string, unknown>;
      if (event.version !== 1 || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))) {
        return true;
      }

      if (event.type === "checkpoint") {
        // Do not allow a checkpoint to clear an unmatched start or an
        // unknown-usage settlement. Those require operator reconciliation.
        if (pendingAttempts.size === 0 && !ambiguousEvidence) {
          uncheckpointedKnownSettlement = false;
        }
        continue;
      }

      if (event.type === "started") {
        if (typeof event.attemptId !== "string" || !event.attemptId ||
            !Number.isSafeInteger(event.maxInputTokens) || (event.maxInputTokens as number) < 0 ||
            !Number.isSafeInteger(event.maxOutputTokens) || (event.maxOutputTokens as number) < 0 ||
            pendingAttempts.has(event.attemptId)) {
          ambiguousEvidence = true;
          continue;
        }
        pendingAttempts.add(event.attemptId);
        continue;
      }

      if (event.type === "settled") {
        if (typeof event.attemptId !== "string" || !event.attemptId ||
            typeof event.usageKnown !== "boolean" || !pendingAttempts.has(event.attemptId)) {
          ambiguousEvidence = true;
          continue;
        }
        pendingAttempts.delete(event.attemptId);
        if (!event.usageKnown) {
          ambiguousEvidence = true;
          continue;
        }
        const usage = event.usage;
        if (!usage || typeof usage !== "object" ||
            !Number.isSafeInteger((usage as Record<string, unknown>).inputTokens) ||
            ((usage as Record<string, number>).inputTokens < 0) ||
            !Number.isSafeInteger((usage as Record<string, unknown>).outputTokens) ||
            ((usage as Record<string, number>).outputTokens < 0)) {
          ambiguousEvidence = true;
          continue;
        }
        uncheckpointedKnownSettlement = true;
        continue;
      }

      ambiguousEvidence = true;
    }

    return pendingAttempts.size > 0 || ambiguousEvidence || uncheckpointedKnownSettlement;
  }

  async acknowledgeCheckpoint(runId: string): Promise<void> {
    if (!runId) throw new Error("Invalid settlement journal checkpoint");
    // Checkpoint acknowledgement happens after provider execution. It must use
    // the same claim boundary so a new worker cannot observe a partially-written
    // checkpoint and begin another billable request concurrently.
    const claim = await this.claimRun(runId);
    try {
      await this.append(runId, { version: 1, type: "checkpoint", at: new Date().toISOString() });
    } finally {
      await claim.release();
    }
  }

  async deleteRun(runId: string): Promise<void> {
    if (!runId) throw new Error("Invalid settlement journal run deletion");
    // Retention cleanup must not remove evidence while a provider attempt owns
    // the run. The same fail-closed claim serializes deletion with inference.
    const claim = await this.claimRun(runId);
    try {
      if (await this.hasUnresolved(runId)) {
        throw new Error("Cannot delete unresolved settlement evidence");
      }
      try {
        await fs.unlink(this.file(runId));
        await this.syncDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } finally {
      await claim.release();
    }
  }
}
