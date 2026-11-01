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
    await fs.chmod(this.directory, 0o700);
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
            try {
              current = JSON.parse(await fs.readFile(lockFile, "utf8")) as { token?: unknown };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                released = true;
                return;
              }
              throw error;
            }
            if (current.token !== token) {
              throw new Error("Settlement run claim ownership changed; refusing to release another worker's claim");
            }
            await fs.unlink(lockFile);
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
    try {
      const existing = await fs.lstat(file);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error("Settlement journal record must be a regular file, not a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // O_NOFOLLOW closes the lstat/open race on platforms that expose it.
    // The lstat check above still rejects pre-existing symlinks elsewhere.
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = await fs.open(
      file,
      fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | noFollow,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new Error("Settlement journal record must be a regular file");
      }
      // chmod the opened inode rather than resolving the path a second time.
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(event) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
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

  async hasUnresolved(runId: string): Promise<boolean> {
    let source: string;
    try {
      source = await fs.readFile(this.file(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } finally {
      await claim.release();
    }
  }
}
