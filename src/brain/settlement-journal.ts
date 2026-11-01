import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sofiaStateDirectory } from "../platform/state-directory.js";
import type { TokenUsage } from "./token-budget.js";

type JournalEvent =
  | { version: 1; type: "started"; attemptId: string; at: string; maxInputTokens: number; maxOutputTokens: number }
  | { version: 1; type: "settled"; attemptId: string; at: string; usageKnown: boolean; usage?: TokenUsage };

export interface SettlementAttempt {
  id: string;
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

  async begin(runId: string, maximum: TokenUsage): Promise<SettlementAttempt> {
    if (!runId || !Number.isSafeInteger(maximum.inputTokens) || maximum.inputTokens < 0 ||
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

  async settle(runId: string, attempt: SettlementAttempt, usage?: TokenUsage): Promise<void> {
    if (!runId || !attempt.id) throw new Error("Invalid settlement journal settlement");
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
    const started = new Set<string>();
    const settled = new Set<string>();
    for (const line of source.split("\n")) {
      if (!line) continue;
      let event: JournalEvent;
      try {
        event = JSON.parse(line) as JournalEvent;
      } catch {
        // Corrupt accounting data is ambiguous and must fail closed.
        return true;
      }
      if (event.version !== 1 || typeof event.attemptId !== "string") return true;
      if (event.type === "started") started.add(event.attemptId);
      else if (event.type === "settled") settled.add(event.attemptId);
      else return true;
    }
    return [...started].some((id) => !settled.has(id));
  }

  async deleteRun(runId: string): Promise<void> {
    try {
      await fs.unlink(this.file(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
