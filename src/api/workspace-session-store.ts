import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";

export interface WorkspaceSessionRecord {
  subject: string;
  createdAt: number;
  expiresAt: number;
}

/** Filesystem-backed opaque sessions; only SHA-256 token digests are used as filenames. */
export class FileWorkspaceSessionStore {
  private readonly directory: string;
  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace session directory must be a real directory.");
    try { chmodSync(this.directory, 0o700); } catch { /* best effort where POSIX modes are unavailable */ }
  }
  private file(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid workspace session digest.");
    return path.join(this.directory, digest + ".json");
  }
  create(subject: string, ttlMs: number): { sessionId: string; session: WorkspaceSessionRecord } {
    if (!subject || subject.length > 512 || !Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * 24 * 60 * 60_000) {
      throw new Error("Invalid workspace session.");
    }
    const sessionId = randomBytes(32).toString("base64url");
    const now = this.now();
    const session = { subject, createdAt: now, expiresAt: now + ttlMs };
    const digest = createHash("sha256").update(sessionId).digest("hex");
    const target = this.file(digest);
    const temporary = target + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(session), { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
      renameSync(temporary, target);
    } catch {
      try { unlinkSync(temporary); } catch { /* absent */ }
      throw new Error("Workspace session persistence failed.");
    }
    return { sessionId, session };
  }
  get(sessionId: string): WorkspaceSessionRecord | null {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(sessionId)) return null;
    const digest = createHash("sha256").update(sessionId).digest("hex");
    try {
      const filename = this.file(digest);
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
      const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const session = value as Partial<WorkspaceSessionRecord>;
      if (typeof session.subject !== "string" || !session.subject ||
          !Number.isSafeInteger(session.createdAt) || !Number.isSafeInteger(session.expiresAt) ||
          (session.expiresAt as number) <= this.now() || (session.expiresAt as number) <= (session.createdAt as number)) {
        this.delete(sessionId);
        return null;
      }
      return { subject: session.subject, createdAt: session.createdAt!, expiresAt: session.expiresAt! };
    } catch { return null; }
  }
  delete(sessionId: string): void {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(sessionId)) return;
    const digest = createHash("sha256").update(sessionId).digest("hex");
    try { unlinkSync(this.file(digest)); } catch { /* absent */ }
  }
  prune(): number {
    let names: string[];
    try { names = readdirSync(this.directory); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const filename = path.join(this.directory, name);
      try {
        const stat = lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
          unlinkSync(filename); removed++; continue;
        }
        const value = JSON.parse(readFileSync(filename, "utf8")) as Partial<WorkspaceSessionRecord>;
        if (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= this.now()) {
          unlinkSync(filename); removed++;
        }
      } catch { try { unlinkSync(filename); removed++; } catch { /* absent */ } }
    }
    return removed;
  }
}
