import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BrowserProfile {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  directory: string;
}

interface BrowserProfileMetadata {
  version: 1;
  id: string;
  ownerHash: string;
  createdAt: string;
  lastUsedAt: string;
}

const execFileAsync = promisify(execFile);

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ownerKey(ownerId: string): string {
  if (!ownerId.trim() || ownerId.length > 512) throw new Error("A valid browser profile owner is required.");
  return createHash("sha256").update(ownerId).digest("hex");
}

async function secureDirectory(pathname: string): Promise<void> {
  if (process.platform === "win32") {
    const username = process.env.USERNAME;
    if (!username) throw new Error("Cannot secure browser profile ACL: current Windows user is unknown.");
    const account = process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" + username : username;
    await execFileAsync("icacls", [
      pathname, "/inheritance:r", "/grant:r",
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
      account + ":(OI)(CI)F",
      "/T", "/C",
    ]);
    return;
  }
  await chmod(pathname, 0o700);
}

async function assertDirectory(pathname: string): Promise<void> {
  const stat = await lstat(pathname);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Browser profile path must be a real directory.");
}

export class BrowserProfileStore {
  private root?: string;

  constructor(private readonly configuredRoot: string) {
    if (!configuredRoot.trim()) throw new Error("Browser profile directory is required.");
  }

  private async rootDirectory(): Promise<string> {
    if (this.root) return this.root;
    await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
    const resolved = await realpath(this.configuredRoot);
    await assertDirectory(resolved);
    await secureDirectory(resolved);
    this.root = resolved;
    return resolved;
  }

  private async ownerDirectory(ownerHash: string): Promise<string> {
    const directory = path.join(await this.rootDirectory(), ownerHash);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertDirectory(directory);
    await secureDirectory(directory);
    return directory;
  }

  private async readMetadata(directory: string, ownerHash: string, id: string): Promise<BrowserProfileMetadata> {
    await assertDirectory(directory);
    const metadataPath = path.join(directory, "sofia-profile.json");
    const stat = await lstat(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Browser profile metadata is invalid.");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<BrowserProfileMetadata>;
    if (metadata.version !== 1 || metadata.id !== id || metadata.ownerHash !== ownerHash ||
        typeof metadata.createdAt !== "string" || typeof metadata.lastUsedAt !== "string") {
      throw new Error("Browser profile ownership or metadata validation failed.");
    }
    return metadata as BrowserProfileMetadata;
  }

  async create(ownerId: string): Promise<BrowserProfile> {
    const hash = ownerKey(ownerId);
    const ownerDirectory = await this.ownerDirectory(hash);
    const id = randomUUID();
    const directory = path.join(ownerDirectory, id);
    await mkdir(directory, { mode: 0o700 });
    await secureDirectory(directory);
    const now = new Date().toISOString();
    const metadata: BrowserProfileMetadata = { version: 1, id, ownerHash: hash, createdAt: now, lastUsedAt: now };
    await writeFile(path.join(directory, "sofia-profile.json"), JSON.stringify(metadata), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { id, createdAt: now, lastUsedAt: now, directory };
  }

  async get(ownerId: string, id: string): Promise<BrowserProfile> {
    if (!PROFILE_ID.test(id)) throw new Error("Invalid browser profile ID.");
    const hash = ownerKey(ownerId);
    const directory = path.join(await this.ownerDirectory(hash), id);
    const metadata = await this.readMetadata(directory, hash, id);
    return { id, createdAt: metadata.createdAt, lastUsedAt: metadata.lastUsedAt, directory };
  }

  async list(ownerId: string): Promise<BrowserProfile[]> {
    const hash = ownerKey(ownerId);
    const directory = await this.ownerDirectory(hash);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(directory, { withFileTypes: true });
    const profiles: BrowserProfile[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROFILE_ID.test(entry.name)) continue;
      try { profiles.push(await this.get(ownerId, entry.name)); } catch { /* Ignore invalid or revoked entries. */ }
    }
    return profiles;
  }

  async revoke(ownerId: string, id: string): Promise<void> {
    const profile = await this.get(ownerId, id);
    await assertDirectory(profile.directory);
    await rm(profile.directory, { recursive: true, force: false });
  }
}
