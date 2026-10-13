import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { ChatMessageDeduplicator } from "./chat-adapter.js";

/**
 * Process-safe, restart-persistent deduplication for verified chat message IDs.
 *
 * Each key is represented by an atomically-created marker file. Markers are
 * intentionally retained after a successful dispatch so a process restart
 * cannot replay an already accepted provider event. Call release only when the
 * downstream API request definitively failed and can safely be retried.
 *
 * The directory should be private to the Sofia service account and on a local
 * filesystem that supports exclusive file creation. For multi-host deployments,
 * use a shared database implementation with a unique constraint instead.
 */
export class FileChatMessageDeduplicator implements ChatMessageDeduplicator {
  private readonly directory: string;

  constructor(directory: string) {
    if (!directory.trim()) throw new Error("A deduplication directory is required.");
    this.directory = path.resolve(directory);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private markerPath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return path.join(this.directory, digest + ".claimed");
  }

  async claim(key: string): Promise<boolean> {
    if (!key) throw new Error("A non-empty deduplication key is required.");
    await this.ensureDirectory();
    const marker = this.markerPath(key);
    let handle;
    try {
      // O_CREAT | O_EXCL: only one concurrent caller can create this marker.
      handle = await open(marker, "wx", 0o600);
      await handle.close();
      return true;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  async release(key: string): Promise<void> {
    if (!key) throw new Error("A non-empty deduplication key is required.");
    try {
      await unlink(this.markerPath(key));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}
