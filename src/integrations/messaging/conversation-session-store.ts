import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export type ConversationMode = "chat" | "task";

export interface ConversationSession {
  turns: string[];
  mode: ConversationMode;
}

export interface ConversationSessionStore {
  load(conversationId: string): Promise<ConversationSession | undefined>;
  save(conversationId: string, session: ConversationSession): Promise<void>;
}

/**
 * Local durable session storage for a single Sofia service instance.
 * Use a database-backed implementation for multi-host deployments.
 * Only bounded, already-filtered conversation turns should be persisted.
 */
export class FileConversationSessionStore implements ConversationSessionStore {
  private readonly directory: string;

  constructor(directory: string) {
    if (!directory.trim()) throw new Error("A conversation session directory is required.");
    this.directory = path.resolve(directory);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private async pruneSessions(protectedPath: string): Promise<void> {\n    const entries = await readdir(this.directory, { withFileTypes: true });\n    const files = await Promise.all(entries\n      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))\n      .map(async (entry) => ({ path: path.join(this.directory, entry.name), modified: (await stat(path.join(this.directory, entry.name))).mtimeMs })));\n    files.sort((a, b) => b.modified - a.modified);\n    const otherFiles = files.filter((file) => file.path !== protectedPath);\n    await Promise.all(otherFiles.slice(499).map((file) => unlink(file.path).catch(() => undefined)));\n  }\n\n  private filePath(conversationId: string): string {
    const digest = createHash("sha256").update(conversationId).digest("hex");
    return path.join(this.directory, digest + ".json");
  }

  async load(conversationId: string): Promise<ConversationSession | undefined> {
    if (!conversationId) throw new Error("A non-empty conversation ID is required.");
    await this.ensureDirectory();
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath(conversationId), "utf8"));
      if (!raw || typeof raw !== "object") return undefined;
      const candidate = raw as { turns?: unknown; mode?: unknown };
      if (!Array.isArray(candidate.turns) || !candidate.turns.every((turn) => typeof turn === "string")) {
        return undefined;
      }
      const turns = candidate.turns.slice(-40).map((turn) => (turn as string).slice(0, 2_000));
      while (turns.join("\n").length > 6_000 && turns.length > 1) turns.shift();
      const mode: ConversationMode = candidate.mode === "task" ? "task" : "chat";
      return { turns, mode };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(conversationId: string, session: ConversationSession): Promise<void> {
    if (!conversationId) throw new Error("A non-empty conversation ID is required.");
    if (session.mode !== "chat" && session.mode !== "task") {
      throw new Error("Invalid conversation mode.");
    }
    await this.ensureDirectory();
    const turns = session.turns.slice(-40).map((turn) => turn.slice(0, 2_000));
    while (turns.join("\n").length > 6_000 && turns.length > 1) turns.shift();
    const target = this.filePath(conversationId);
    const temporary = path.join(this.directory, "." + path.basename(target) + "." + randomUUID() + ".tmp");
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ turns, mode: session.mode }), "utf8");
      await handle.close();
      handle = undefined;
      await rename(temporary, target);\n      await this.pruneSessions(target);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      const { unlink } = await import("node:fs/promises");
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
