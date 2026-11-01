import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
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
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);

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
    return {
      assertRun: (claimedRunId: string) => {
        if (released || claimedRunId !== runId) {
          throw new Error("Settlement run claim is missing, released, or belongs to another run");
        }
      },
      release: async () => {
        if (released) return;
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
      },
    };
  }

  private async append(runId: string, event: JournalEvent): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const file = this.file(runId);
    const handle = await fs.open(file, "a", 0o600);
    try {
      await handle.writeFile(JSON.stringify(event) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(file, 0o600);
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
    let hasUncheckpointedAttempt = false;
    for (const line of source.split("\n")) {
      if (!line) continue;
      let event: JournalEvent;
      try { event = JSON.parse(line) as JournalEvent; }
      catch { return true; }
      if (event.version !== 1) return true;
      if (event.type === "checkpoint") hasUncheckpointedAttempt = false;
      else if (event.type === "started") hasUncheckpointedAttempt = true;
      else if (event.type !== "settled" || typeof event.attemptId !== "string") return true;
    }
    return hasUncheckpointedAttempt;
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
