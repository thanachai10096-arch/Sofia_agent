import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function assertPrivateDirectory(info: Awaited<ReturnType<typeof lstat>>, description: string): void {
  // POSIX mode bits are meaningful on Unix. Windows ACLs are managed separately.
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(description + " must not grant group or other users access.");
  }
}

/**
 * Maps an authenticated principal to an opaque, stable workspace directory.
 * This is a resolver primitive only: callers must construct all per-user
 * runtimes and mutable stores from the returned directory before enabling
 * multi-tenant execution.
 */
export class PrincipalWorkspaceResolver {
  private rootPromise?: Promise<string>;

  constructor(private readonly configuredRoot: string) {
    if (!configuredRoot.trim() || !path.isAbsolute(configuredRoot)) {
      throw new Error("Principal workspace root must be a non-empty absolute path.");
    }
  }

  private async root(): Promise<string> {
    if (!this.rootPromise) {
      this.rootPromise = (async () => {
        const configured = path.resolve(this.configuredRoot);
        await mkdir(configured, { recursive: true, mode: 0o700 });
        const info = await lstat(configured);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error("Principal workspace root must be a real directory, not a symbolic link.");
        }
        assertPrivateDirectory(info, "Principal workspace root");
        return realpath(configured);
      })();
    }
    return this.rootPromise;
  }

  async resolve(principalId: string): Promise<string> {
    if (typeof principalId !== "string" || !principalId.trim() || principalId.length > 512 ||
        /[\x00-\x1f\x7f]/.test(principalId)) {
      throw new Error("A valid authenticated principal ID is required.");
    }

    const root = await this.root();
    const opaqueId = createHash("sha256").update(principalId, "utf8").digest("hex");
    const candidate = path.join(root, opaqueId);
    if (!within(root, candidate)) throw new Error("Principal workspace escapes its configured root.");

    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Principal workspace must be a real directory, not a symbolic link.");
    }
    assertPrivateDirectory(info, "Principal workspace");
    const canonical = await realpath(candidate);
    if (!within(root, canonical)) throw new Error("Principal workspace escapes its configured root.");
    return canonical;
  }
}
