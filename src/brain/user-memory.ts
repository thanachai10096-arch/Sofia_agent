import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { containsPromptInjection, redactSecrets } from "../security/guard.js";

export type UserMemoryKind = "preference" | "fact" | "goal" | "instruction";

export interface UserMemoryEntry {
  id: string;
  kind: UserMemoryKind;
  content: string;
  source: "explicit-user-request";
  confidence: number;
  createdAt: string;
  updatedAt: string;
  uses: number;
}

export interface UserMemoryStore {
  save(userId: string, entry: UserMemoryEntry): Promise<void>;
  list(userId: string): Promise<UserMemoryEntry[]>;
  find(userId: string, query: string, limit?: number): Promise<UserMemoryEntry[]>;
  delete(userId: string, id: string): Promise<boolean>;
  clear(userId: string): Promise<void>;
}

const MAX_ENTRIES = 200;
const MAX_CONTENT_CHARS = 1200;
const ALLOWED_KINDS = new Set<UserMemoryKind>(["preference", "fact", "goal", "instruction"]);
const USER_MEMORY_WRITES = new Map<string, Promise<void>>();

function redactMemorySecrets(content: string): string {
  return String(redactSecrets(content))
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
}

function defaultUserMemoryDirectory(): string {
  const configured = process.env.SOFIA_STATE_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("SOFIA_STATE_DIR must be an absolute path.");
    return path.join(configured, "sofia-agents-user-memory");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Sofia Agents", "user-memory");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Sofia Agents", "user-memory");
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  const root = dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(os.homedir(), ".local", "share");
  return path.join(root, "sofia-agents", "user-memory");
}

function userKey(userId: string): string {
  if (typeof userId !== "string" || !userId.trim() || userId.length > 512) {
    throw new Error("A valid user identity is required for user memory.");
  }
  return createHash("sha256").update(userId.trim()).digest("hex");
}

function validEntry(value: unknown): value is UserMemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<UserMemoryEntry>;
  return typeof entry.id === "string" && entry.id.length > 0 &&
    typeof entry.content === "string" && entry.content.length > 0 &&
    typeof entry.kind === "string" && ALLOWED_KINDS.has(entry.kind as UserMemoryKind) &&
    entry.source === "explicit-user-request" &&
    typeof entry.confidence === "number" && Number.isFinite(entry.confidence) &&
    typeof entry.createdAt === "string" && typeof entry.updatedAt === "string" &&
    typeof entry.uses === "number" && Number.isFinite(entry.uses) && entry.uses >= 0;
}

/**
 * User-scoped, local-first memory. Identity is hashed before it is used in a
 * filename; content is secret-redacted and prompt-injection checked. Only
 * explicitly requested memories should be written by callers.
 */
export class FileUserMemoryStore implements UserMemoryStore {
  constructor(private readonly root = defaultUserMemoryDirectory()) {}

  private async withUserWriteLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.root) + ":" + userKey(userId);
    const previous = USER_MEMORY_WRITES.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    USER_MEMORY_WRITES.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (USER_MEMORY_WRITES.get(key) === tail) USER_MEMORY_WRITES.delete(key);
    }
  }

  private fileFor(userId: string): string {
    return path.join(this.root, userKey(userId) + ".json");
  }

  private async read(userId: string): Promise<UserMemoryEntry[]> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.fileFor(userId), "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter(validEntry)
        .filter((entry) => !containsPromptInjection(entry.content))
        .slice(-MAX_ENTRIES)
        .map((entry) => ({ ...entry, content: entry.content.slice(0, MAX_CONTENT_CHARS) }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      // Corrupt or unreadable memory must not stop an agent run.
      return [];
    }
  }

  async save(userId: string, entry: UserMemoryEntry): Promise<void> {
    userKey(userId);
    if (!validEntry(entry)) throw new Error("Invalid user memory entry.");
    if (containsPromptInjection(entry.content)) throw new Error("Memory entry rejected by prompt-injection guard.");
    const content = redactMemorySecrets(entry.content).trim().slice(0, MAX_CONTENT_CHARS);
    if (!content) throw new Error("User memory content is empty after sanitization.");
    const safeEntry: UserMemoryEntry = {
      ...entry,
      content,
      confidence: Number.isFinite(entry.confidence) ? Math.max(0, Math.min(1, entry.confidence)) : 0.5,
      uses: Math.max(0, Math.floor(entry.uses)),
    };
    await this.withUserWriteLock(userId, async () => {
      const entries = await this.read(userId);
      const index = entries.findIndex((item) => item.id === safeEntry.id);
      if (index >= 0) entries[index] = safeEntry;
      else entries.push(safeEntry);
      await this.writeEntries(userId, entries.slice(-MAX_ENTRIES));
    });
  }

  async list(userId: string): Promise<UserMemoryEntry[]> {
    userKey(userId);
    return this.read(userId);
  }

  async find(userId: string, query: string, limit = 8): Promise<UserMemoryEntry[]> {
    userKey(userId);
    const normalized = query.toLocaleLowerCase().trim();
    const rawTerms = normalized.split(/\s+/).flatMap((part) => part.match(/[\p{L}\p{N}_-]+/gu) ?? []);
    const termSet = new Set<string>();
    for (const term of rawTerms) {
      if (term.length <= 1) continue;
      const characters = Array.from(term);
      // Thai, CJK, and other unspaced scripts often arrive as one token.
      // Add bounded character trigrams so a short task can retrieve a related
      // memory without requiring whitespace-based word segmentation.
      if (characters.length >= 4 && /[^\u0000-\u024F]/u.test(term)) {
        for (let index = 0; index <= characters.length - 3 && termSet.size < 32; index += 1) {
          termSet.add(characters.slice(index, index + 3).join(""));
        }
      } else {
        termSet.add(term);
      }
      if (termSet.size >= 32) break;
    }
    const terms = [...termSet].slice(0, 32);
    if (terms.length === 0) return [];
    const matches = (await this.read(userId)).map((entry) => {
      const text = (entry.kind + " " + entry.content).toLowerCase();
      const score = terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
      return { entry, score };
    }).filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, Math.max(1, Math.min(20, Math.floor(limit))))
      .map(({ entry }) => entry);
    return matches;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    userKey(userId);
    return this.withUserWriteLock(userId, async () => {
      const entries = await this.read(userId);
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return false;
      await this.writeEntries(userId, next);
      return true;
    });
  }

  async clear(userId: string): Promise<void> {
    userKey(userId);
    await this.withUserWriteLock(userId, async () => {
      await fs.rm(this.fileFor(userId), { force: true });
    });
  }

  /**
   * Read-only snapshot of exactly one user's persisted memory file. The
   * filename contains only the hashed identity; no directory enumeration or
   * mutation occurs. Raw bytes are preserved for integrity verification.
   */
  async backupSnapshot(userId: string): Promise<{ path: string; content: Uint8Array } | undefined> {
    const identityKey = userKey(userId);
    try {
      const content = await fs.readFile(this.fileFor(userId));
      return { path: `user-memory/${identityKey}.json`, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeEntries(userId: string, entries: UserMemoryEntry[]): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    const file = this.fileFor(userId);
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

export function explicitUserMemoryFromMessage(message: string): { kind: UserMemoryKind; content: string } | undefined {
  const trimmed = message.trim();
  const patterns: Array<{ regex: RegExp; kind: UserMemoryKind }> = [
    { regex: /^(?:please\s+)?remember\s+(?:that\s+)?I\s+prefer\s+(.+)$/i, kind: "preference" },
    { regex: /^(?:please\s+)?remember\s+(?:that\s+)?my\s+goal\s+is\s+(.+)$/i, kind: "goal" },
    { regex: /^(?:please\s+)?remember\s+(?:that\s+)?(.+)$/i, kind: "fact" },
    { regex: /^(?:help me )?remember that\s*(.+)$/i, kind: "fact" },
    { regex: /^จำไว้ว่า\s*ฉันชอบ\s*(.+)$/u, kind: "preference" },
    { regex: /^จำไว้ว่าฉันชอบ\s*(.+)$/u, kind: "preference" },
    { regex: /^(?:ช่วย)?จำไว้ว่า\s*(.+)$/u, kind: "fact" },
    { regex: /^เป้าหมายของฉันคือ\s*(.+)$/u, kind: "goal" },
  ];
  for (const { regex, kind } of patterns) {
    const match = trimmed.match(regex);
    const content = match?.[1]?.trim().replace(/[.!。\s]+$/u, "");
    if (content && content.length >= 3 && content.length <= MAX_CONTENT_CHARS &&
        !containsPromptInjection(content)) return { kind, content };
  }
  return undefined;
}

export function createUserMemoryEntry(kind: UserMemoryKind, content: string): UserMemoryEntry {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind,
    content,
    source: "explicit-user-request",
    confidence: 1,
    createdAt: now,
    updatedAt: now,
    uses: 0,
  };
}
