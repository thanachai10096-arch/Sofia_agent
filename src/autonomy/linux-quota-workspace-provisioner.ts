import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface LinuxQuotaWorkspaceProvisionerOptions {
  /** Absolute path to a root-owned, non-writable host helper implementing the protocol below. */
  helperPath: string;
  /** Dedicated quota-enabled filesystem mount; each workspace must be a direct child. */
  workspaceRoot: string;
  /** Hard per-run byte quota enforced by the host helper (not a post-run check). */
  maxWorkspaceBytes: number;
  helperTimeoutMs?: number;
  maxHelperOutputBytes?: number;
}

interface ActiveWorkspace {
  runId: string;
  workspacePath: string;
}

interface HelperReply {
  ok: boolean;
  runId?: string;
  workspacePath?: string;
  quotaBytes?: number;
  quotaInodes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Calls a narrowly-scoped, host-installed Linux helper. The helper must allocate
 * a unique XFS/ext4 project-quota ID, set hard block and inode limits, verify
 * those limits, and only then return the workspace path.
 *
 * This adapter intentionally does not implement quotas in Node: the application
 * process must not pretend that directory sizing or a Boolean flag is a quota.
 */
export class LinuxQuotaWorkspaceProvisioner {
  private readonly active = new Map<string, ActiveWorkspace>();
  private readonly helperPath: string;
  private readonly workspaceRoot: string;
  private readonly maxWorkspaceBytes: number;
  private readonly helperTimeoutMs: number;
  private readonly maxHelperOutputBytes: number;

  constructor(options: LinuxQuotaWorkspaceProvisionerOptions) {
    if (process.platform !== "linux") throw new Error("Linux quota workspaces are supported only on Linux hosts.");
    if (!path.isAbsolute(options.helperPath) || !path.isAbsolute(options.workspaceRoot)) {
      throw new Error("Quota helper and workspace root must be absolute paths.");
    }
    if (!Number.isSafeInteger(options.maxWorkspaceBytes) || options.maxWorkspaceBytes < 1024 * 1024) {
      throw new Error("maxWorkspaceBytes must be at least 1 MiB.");
    }
    this.helperPath = path.resolve(options.helperPath);
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.maxWorkspaceBytes = options.maxWorkspaceBytes;
    this.helperTimeoutMs = options.helperTimeoutMs ?? 15_000;
    this.maxHelperOutputBytes = options.maxHelperOutputBytes ?? 16 * 1024;
    for (const [name, value] of Object.entries({
      helperTimeoutMs: this.helperTimeoutMs,
      maxHelperOutputBytes: this.maxHelperOutputBytes,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + " must be a positive safe integer.");
    }
  }

  private async verifyHelper(): Promise<void> {
    const resolved = await realpath(this.helperPath);
    if (resolved !== this.helperPath) throw new Error("Quota helper path and all parent components must be canonical, not symlinked.");
    let parent = path.dirname(resolved);
    while (true) {
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== 0 ||
          (parentInfo.mode & 0o022) !== 0) {
        throw new Error("Every quota helper parent directory must be root-owned and not writable by group or others.");
      }
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) {
      throw new Error("Quota helper must be an executable, root-owned file not writable by group or others.");
    }
  }

  private async invoke(payload: Record<string, unknown>): Promise<HelperReply> {
    await this.verifyHelper();
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, ["--stdio-json"], {
        shell: false,
        windowsHide: true,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error, reply?: HelperReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else if (reply) resolve(reply);
        else reject(new Error("Quota helper returned no response."));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("Quota helper timed out."));
      }, this.helperTimeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > this.maxHelperOutputBytes) {
          child.kill("SIGKILL");
          finish(new Error("Quota helper output exceeded its limit."));
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > this.maxHelperOutputBytes) {
          child.kill("SIGKILL");
          finish(new Error("Quota helper diagnostics exceeded its limit."));
        }
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) return finish(new Error("Quota helper failed with exit code " + String(code) + "."));
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (!isRecord(parsed) || parsed.ok !== true) throw new Error("Quota helper did not confirm success.");
          const allowedReplyKeys = new Set(["ok", "runId", "workspacePath", "quotaBytes", "quotaInodes"]);
          if (Object.keys(parsed).some((key) => !allowedReplyKeys.has(key)) ||
              typeof parsed.runId !== "string" ||
              (parsed.workspacePath !== undefined && typeof parsed.workspacePath !== "string") ||
              (parsed.quotaBytes !== undefined && (!Number.isSafeInteger(parsed.quotaBytes) || parsed.quotaBytes < 1)) ||
              (parsed.quotaInodes !== undefined && (!Number.isSafeInteger(parsed.quotaInodes) || parsed.quotaInodes < 1))) {
            throw new Error("Quota helper returned an unexpected or malformed response.");
          }
          finish(undefined, parsed as HelperReply);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Invalid quota helper response."));
        }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async createWorkspace(): Promise<string> {
    const root = await realpath(this.workspaceRoot);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("Quota workspace root must be a real directory.");
    }
    const runId = randomUUID();
    try {
      const reply = await this.invoke({
        operation: "create",
        runId,
        workspaceRoot: root,
        hardQuotaBytes: this.maxWorkspaceBytes,
        hardQuotaInodes: 20_000,
      });
      if (reply.runId !== runId || typeof reply.workspacePath !== "string" || reply.quotaBytes !== this.maxWorkspaceBytes || reply.quotaInodes !== 20_000) {
        throw new Error("Quota helper did not confirm the requested hard quota.");
      }
      const workspacePath = await realpath(reply.workspacePath);
      const info = await lstat(workspacePath);
      if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(workspacePath) !== root) {
        throw new Error("Quota helper returned a workspace outside the dedicated quota root.");
      }
      if ([...this.active.values()].some((entry) => entry.workspacePath === workspacePath)) {
        throw new Error("Quota helper returned a workspace already assigned to another run.");
      }
      this.active.set(workspacePath, { runId, workspacePath });
      return workspacePath;
    } catch (error) {
      // The helper may have allocated a quota before a response was lost or rejected.
      // Abort by the unguessable run ID so partial allocations cannot leak silently.
      try {
        const cleanup = await this.invoke({ operation: "abort", runId, workspaceRoot: root });
        if (cleanup.ok !== true || cleanup.runId !== runId) throw new Error("Quota helper did not confirm aborted allocation cleanup.");
      } catch {
        throw new Error("Workspace allocation failed and host cleanup could not be confirmed; operator intervention is required.", { cause: error });
      }
      throw error;
    }
  }

  async disposeWorkspace(workspacePath: string): Promise<void> {
    const workspace = this.active.get(workspacePath);
    if (!workspace) throw new Error("Cannot dispose a workspace not created by this provisioner.");
    const reply = await this.invoke({
      operation: "dispose",
      runId: workspace.runId,
      workspacePath: workspace.workspacePath,
    });
    if (reply.ok !== true || reply.runId !== workspace.runId) throw new Error("Quota helper did not confirm disposal for the requested run.");
    this.active.delete(workspacePath);
  }
}
