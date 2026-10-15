import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ConversationMessage, ConversationSession, ConversationStore } from "./types.js";

const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(["user", "assistant", "tool"]);
const MAX_FILE_BYTES = 8_000_000;
const MAX_MESSAGES = 10_000;
const MAX_TEXT = 100_000;

function validMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<ConversationMessage>;
  return typeof message.id === "string" && SAFE_ID.test(message.id)
    && typeof message.role === "string" && ROLES.has(message.role)
    && typeof message.content === "string" && message.content.length <= MAX_TEXT
    && Number.isSafeInteger(message.createdAt) && (message.createdAt as number) >= 0
    && (message.toolName === undefined || (typeof message.toolName === "string" && message.toolName.length <= 120));
}

function validSession(value: unknown, filename: string): value is ConversationSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Partial<ConversationSession>;
  return typeof session.id === "string" && SAFE_ID.test(session.id)
    && filename === session.id + ".json"
    && typeof session.ownerId === "string" && session.ownerId.length > 0 && session.ownerId.length <= 256
    && typeof session.title === "string" && session.title.length > 0 && session.title.length <= 160
    && Number.isSafeInteger(session.createdAt) && (session.createdAt as number) >= 0
    && Number.isSafeInteger(session.updatedAt) && (session.updatedAt as number) >= (session.createdAt as number)
    && Array.isArray(session.messages) && session.messages.length <= MAX_MESSAGES
    && session.messages.every(validMessage);
}

function clone(session: ConversationSession): ConversationSession {
  return { ...session, messages: session.messages.map((message) => ({ ...message })) };
}

/**
 * Single-process durable JSON store. Files are owner-filtered by the service layer,
 * written atomically, and restricted to the current OS user where supported.
 * For multi-process/serverless deployments, use a transactional database adapter.
 */
export class FileConversationStore implements ConversationStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* platform may not support POSIX modes */ }
  }

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error("Unsafe conversation id.");
    return path.join(this.directory, id + ".json");
  }

  get(id: string): ConversationSession | undefined {
    const filename = this.file(id);
    try {
      const statSize = readFileSync(filename);
      if (statSize.byteLength > MAX_FILE_BYTES) {
        try { unlinkSync(filename); } catch { /* best effort */ }
        return undefined;
      }
      const parsed: unknown = JSON.parse(statSize.toString("utf8"));
      if (!validSession(parsed, path.basename(filename))) {
        try { unlinkSync(filename); } catch { /* best effort */ }
        return undefined;
      }
      return clone(parsed);
    } catch {
      return undefined;
    }
  }

  save(session: ConversationSession): void {
    const target = this.file(session.id);
    if (!validSession(session, path.basename(target))) throw new Error("Invalid conversation session.");
    const serialized = JSON.stringify(session);
    if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) throw new Error("Conversation session exceeds storage limit.");
    const temporary = target + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".tmp";
    try {
      writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { chmodSync(temporary, 0o600); } catch { /* platform may not support POSIX modes */ }
      renameSync(temporary, target);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
      throw error;
    }
  }

  delete(id: string): boolean {
    const filename = this.file(id);
    try { unlinkSync(filename); return true; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  listByOwner(ownerId: string): ConversationSession[] {
    let names: string[];
    try { names = readdirSync(this.directory); } catch { return []; }
    const sessions: ConversationSession[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) {
        if (name.endsWith(".tmp")) try { unlinkSync(path.join(this.directory, name)); } catch { /* best effort */ }
        continue;
      }
      const id = name.slice(0, -5);
      if (!SAFE_ID.test(id)) continue;
      const session = this.get(id);
      if (session?.ownerId === ownerId) sessions.push(session);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
