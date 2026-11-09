import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";

export interface DesktopCommandOutcome {
  result?: unknown;
  error?: string;
}

export type DesktopCommandJournalEntry =
  | { commandId: string; status: "started"; updatedAt: number }
  | { commandId: string; status: "completed"; updatedAt: number; outcome: DesktopCommandOutcome };

export interface DesktopCommandJournal {
  get(commandId: string): Promise<DesktopCommandJournalEntry | null>;
  begin(commandId: string): Promise<void>;
  complete(commandId: string, outcome: DesktopCommandOutcome): Promise<void>;
}

/**
 * Local durable execution journal. A "started" entry is deliberately not
 * replayed after a restart: the native side effect may have happened before
 * the process died. Completed outcomes are retained so delivery can be retried
 * without repeating the native action.
 */
export class FileDesktopCommandJournal implements DesktopCommandJournal {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Desktop command journal must be a real directory.");
    try { chmodSync(this.directory, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
  }

  private filename(commandId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(commandId)) throw new Error("Invalid desktop command journal ID.");
    return path.join(this.directory, createHash("sha256").update(commandId).digest("hex") + ".json");
  }

  async get(commandId: string): Promise<DesktopCommandJournalEntry | null> {
    const filename = this.filename(commandId);
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 6 * 1024 * 1024) {
        throw new Error("Desktop command journal record is invalid.");
      }
      const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop command journal record is malformed.");
      const entry = value as DesktopCommandJournalEntry;
      if (entry.commandId !== commandId || !["started", "completed"].includes(entry.status) ||
          !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0 ||
          (entry.status === "completed" && (!entry.outcome || typeof entry.outcome !== "object" || Array.isArray(entry.outcome)))) {
        throw new Error("Desktop command journal record failed validation.");
      }
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Desktop command journal could not be read.");
    }
  }

  async begin(commandId: string): Promise<void> {
    this.pruneCompleted();
    const existing = await this.get(commandId);
    if (existing) throw new Error("Desktop command journal entry already exists.");
    this.writeNew(commandId, { commandId, status: "started", updatedAt: Date.now() });
  }

  async complete(commandId: string, outcome: DesktopCommandOutcome): Promise<void> {
    const existing = await this.get(commandId);
    if (!existing || existing.status !== "started") throw new Error("Desktop command journal has no active execution.");
    const serialized = JSON.stringify(outcome);
    if (Buffer.byteLength(serialized, "utf8") > 5 * 1024 * 1024) throw new Error("Desktop command outcome exceeds journal limit.");
    this.write(commandId, { commandId, status: "completed", updatedAt: Date.now(), outcome });
  }

  private pruneCompleted(): void {
    const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
    let retained = 0;
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const filename = path.join(this.directory, name);
      try {
        const stat = lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const value = JSON.parse(readFileSync(filename, "utf8")) as { status?: unknown };
        if (value?.status === "completed" && stat.mtimeMs < cutoff) {
          unlinkSync(filename);
          continue;
        }
        retained += 1;
      } catch {
        // Preserve unreadable records rather than deleting evidence of an action.
        retained += 1;
      }
    }
    if (retained >= 10_000) throw new Error("Desktop command journal capacity reached; inspect and archive old records before accepting more actions.");
  }

  private writeNew(commandId: string, entry: DesktopCommandJournalEntry): void {
    const target = this.filename(commandId);
    let descriptor: number | undefined;
    try {
      // O_EXCL semantics prevent two local Companion processes from both
      // acquiring the same command and performing the native side effect.
      descriptor = openSync(target, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(entry), { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try { chmodSync(target, 0o600); } catch { /* best effort */ }
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* already closed */ }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Desktop command journal entry already exists.");
      }
      throw new Error("Desktop command journal persistence failed.");
    }
  }

  private write(commandId: string, entry: DesktopCommandJournalEntry): void {
    const target = this.filename(commandId);
    const temporary = target + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp";
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(entry), { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
      renameSync(temporary, target);
    } catch {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* already closed */ }
      }
      try { unlinkSync(temporary); } catch { /* absent */ }
      throw new Error("Desktop command journal persistence failed.");
    }
  }
}
