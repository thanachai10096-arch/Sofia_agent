import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { requireCapability, resolveWorkspacePath, resolveWorkspaceRoot } from "./policy.js";
import type { DesktopCommandResult, DesktopFileEntry, DesktopPrincipal, DesktopRuntimeConfig, DesktopSystemInfo } from "./types.js";

const DEFAULT_ALLOWED_EXECUTABLES = ["git", "node", "npm", "npx", "pnpm", "yarn", "python", "python3", "pytest", "tsc"];

export class DesktopRuntime {
  private readonly rootPromise: Promise<string>;
  private readonly allowedExecutables: Set<string>;
  private readonly maxOutputBytes: number;
  private readonly commandTimeoutMs: number;

  constructor(private readonly config: DesktopRuntimeConfig) {
    this.rootPromise = resolveWorkspaceRoot(config.workspaceRoot);
    this.allowedExecutables = new Set(config.allowedExecutables ?? []);
    this.maxOutputBytes = Math.max(1024, config.maxOutputBytes ?? 256_000);
    this.commandTimeoutMs = Math.max(1000, config.commandTimeoutMs ?? 60_000);
  }

  async discover(principal: DesktopPrincipal): Promise<DesktopSystemInfo> {
    requireCapability(principal, "system:discover");
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      workspaceRoot: await this.rootPromise,
      capabilities: [...principal.capabilities],
    };
  }

  async listFiles(principal: DesktopPrincipal, relativePath = "."): Promise<DesktopFileEntry[]> {
    requireCapability(principal, "workspace:list");
    const root = await this.rootPromise;
    const target = relativePath === "." ? root : await resolveWorkspacePath(root, relativePath);
    const entries = await readdir(target, { withFileTypes: true });
    const results: DesktopFileEntry[] = [];
    for (const entry of entries) {
      const fullPath = path.join(target, entry.name);
      const info = await lstat(fullPath);
      const kind = entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
      results.push({
        name: entry.name,
        kind,
        ...(kind === "file" ? { size: info.size } : {}),
        modifiedAt: info.mtime.toISOString(),
      });
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readTextFile(principal: DesktopPrincipal, relativePath: string): Promise<string> {
    requireCapability(principal, "workspace:read");
    const target = await resolveWorkspacePath(await this.rootPromise, relativePath);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Only regular files can be read.");
    if (info.size > this.maxOutputBytes) throw new Error("File exceeds the configured read limit.");
    return readFile(target, "utf8");
  }

  async writeTextFile(principal: DesktopPrincipal, relativePath: string, content: string): Promise<{ path: string; bytes: number }> {
    requireCapability(principal, "workspace:write");
    const root = await this.rootPromise;
    const target = await resolveWorkspacePath(root, relativePath, true);
    if (Buffer.byteLength(content, "utf8") > this.maxOutputBytes) throw new Error("Content exceeds the configured write limit.");
    await mkdir(path.dirname(target), { recursive: true });
    // Atomic replace within the same directory; never follow an existing symlink.
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) throw new Error("Refusing to write through a symbolic link.");
    const temporary = path.join(path.dirname(target), `.sofia-${process.pid}-${Date.now()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return { path: path.relative(root, target), bytes: Buffer.byteLength(content, "utf8") };
  }

  async runCommand(
    principal: DesktopPrincipal,
    command: string,
    args: string[] = [],
    options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<DesktopCommandResult> {
    requireCapability(principal, "process:execute");
    const executable = path.basename(command);
    if (!this.allowedExecutables.has(executable)) throw new Error(`Executable "${executable}" is not allowlisted.`);
    if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid command argument.");
    const root = await this.rootPromise;
    const cwd = options.cwd && options.cwd !== "." ? await resolveWorkspacePath(root, options.cwd) : root;
    const started = performance.now();
    const timeoutMs = Math.min(Math.max(1000, options.timeoutMs ?? this.commandTimeoutMs), this.commandTimeoutMs);
    const output = { stdout: "", stderr: "", bytes: 0 };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      };
      const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const append = (key: "stdout" | "stderr", chunk: Buffer) => {
        output.bytes += chunk.length;
        if (output.bytes > this.maxOutputBytes) {
          child.kill();
          finishError(new Error("Command output exceeded the configured limit."));
          return;
        }
        output[key] += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", (error) => finishError(error));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        resolve({
          command: executable,
          args: [...args],
          exitCode: code ?? -1,
          stdout: output.stdout,
          stderr: output.stderr,
          durationMs: Math.round(performance.now() - started),
        });
      });
      const abort = () => { child.kill(); finishError(new Error("Command aborted.")); };
      const timer = setTimeout(() => { child.kill(); finishError(new Error("Command timed out.")); }, timeoutMs);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export function createDesktopPrincipal(id: string, capabilities: readonly DesktopPrincipal["capabilities"] extends ReadonlySet<infer T> ? T[] : never): DesktopPrincipal {
  return { id, capabilities: new Set(capabilities) };
}
