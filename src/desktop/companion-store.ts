import { createHash } from "node:crypto";
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";

export interface DesktopCompanionRecord {
  ownerKeyId: string;
  tokenDigest: string;
  connectedAt: number;
  lastSeenAt: number;
}

export interface DesktopCompanionStore {
  loadAll(): DesktopCompanionRecord[];
  save(record: DesktopCompanionRecord): void;
  delete(ownerKeyId: string): void;
}

const OWNER = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;

/**
 * Persists only the SHA-256 digest of a random companion bearer token.
 * Owner IDs are hashed for filenames; the record is still owner-bound.
 * Pending commands are intentionally never persisted or replayed after restart.
 */
export class FileDesktopCompanionStore implements DesktopCompanionStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Desktop companion store must be a real directory.");
    }
    try { chmodSync(this.directory, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
  }

  private filename(ownerKeyId: string): string {
    if (!OWNER.test(ownerKeyId)) throw new Error("Invalid desktop companion owner ID.");
    const name = createHash("sha256").update(ownerKeyId).digest("hex");
    return path.join(this.directory, name + ".json");
  }

  loadAll(): DesktopCompanionRecord[] {
    const records: DesktopCompanionRecord[] = [];
    let names: string[];
    try { names = readdirSync(this.directory); } catch {
      throw new Error("Desktop companion store could not be read.");
    }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const filename = path.join(this.directory, name);
      try {
        const stat = lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
          unlinkSync(filename);
          continue;
        }
        const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          unlinkSync(filename); continue;
        }
        const record = value as Partial<DesktopCompanionRecord>;
        if (typeof record.ownerKeyId !== "string" || !OWNER.test(record.ownerKeyId) ||
            createHash("sha256").update(record.ownerKeyId).digest("hex") + ".json" !== name ||
            typeof record.tokenDigest !== "string" || !DIGEST.test(record.tokenDigest) ||
            !Number.isSafeInteger(record.connectedAt) || !Number.isSafeInteger(record.lastSeenAt) ||
            (record.connectedAt as number) < 0 || (record.lastSeenAt as number) < (record.connectedAt as number)) {
          unlinkSync(filename); continue;
        }
        records.push({
          ownerKeyId: record.ownerKeyId,
          tokenDigest: record.tokenDigest,
          connectedAt: record.connectedAt!,
          lastSeenAt: record.lastSeenAt!,
        });
      } catch {
        try { unlinkSync(filename); } catch { /* malformed entry is ignored */ }
      }
    }
    return records;
  }

  save(record: DesktopCompanionRecord): void {
    if (!OWNER.test(record.ownerKeyId) || !DIGEST.test(record.tokenDigest) ||
        !Number.isSafeInteger(record.connectedAt) || !Number.isSafeInteger(record.lastSeenAt) ||
        record.connectedAt < 0 || record.lastSeenAt < record.connectedAt) {
      throw new Error("Invalid desktop companion record.");
    }
    const target = this.filename(record.ownerKeyId);
    const temporary = target + "." + process.pid + "." + createHash("sha256")
      .update(String(Date.now()) + Math.random()).digest("hex").slice(0, 16) + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
      renameSync(temporary, target);
    } catch {
      try { unlinkSync(temporary); } catch { /* absent */ }
      throw new Error("Desktop companion persistence failed.");
    }
  }

  delete(ownerKeyId: string): void {
    try { unlinkSync(this.filename(ownerKeyId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Desktop companion revocation could not be persisted.");
      }
    }
  }
}
