import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  allowNetwork: boolean;
  workspaceRoot: string;
  /** Optional workspace-relative working directory. */
  cwd?: string;
  /** Additional environment variable names explicitly permitted for this child. */
  allowedEnvironmentVariables?: string[];
}

export interface Sandbox {
  readonly isolation: "policy" | "process" | "container";
  run(
    command: string,
    args: string[],
    limits: SandboxLimits,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  /** Optional liveness/readiness probe for independently operated runners. */
  healthCheck?(): Promise<void>;
}

export class PolicySandbox implements Sandbox {
  readonly isolation = "policy" as const;

  constructor(
    private readonly runner: (
      command: string,
      args: string[],
      limits: SandboxLimits,
      signal?: AbortSignal,
    ) => Promise<{ stdout: string; stderr: string; code: number }>,
  ) {}

  run(command: string, args: string[], limits: SandboxLimits, signal?: AbortSignal) {
    return this.runner(command, args, limits, signal);
  }
}

/**
 * A bounded child-process runner, not an OS/container sandbox. It cannot
 * enforce filesystem isolation or disable networking. Requests that require
 * network isolation therefore fail closed when allowNetwork is false.
 */
const BASE_CHILD_ENV = new Set([
  "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "COMSPEC",
  "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "LANG", "LC_ALL", "TERM", "CI",
]);
const BLOCKED_CHILD_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT)$/i;

function safeEnv(extraAllowed: readonly string[] = []): NodeJS.ProcessEnv {
  if (extraAllowed.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("Allowed environment variable names must be valid identifiers.");
  }
  const allowed = new Set([...BASE_CHILD_ENV, ...extraAllowed].map((name) => name.toUpperCase()));
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      allowed.has(name.toUpperCase()) && !BLOCKED_CHILD_ENV.test(name),
    ),
  );
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  return Math.floor(value);
}

export class ProcessSandbox implements Sandbox {
  readonly isolation = "process" as const;

  async run(
    command: string,
    args: string[],
    limits: SandboxLimits,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!command.trim()) throw new Error("A command is required.");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error("Command arguments must be strings without NUL bytes.");
    }
    if (!limits.workspaceRoot.trim()) throw new Error("A workspace root is required.");
    const timeoutMs = positiveFinite(limits.timeoutMs, "timeoutMs");
    const maxOutputBytes = positiveFinite(limits.maxOutputBytes, "maxOutputBytes");
    const { realpath, stat } = await import("node:fs/promises");
    const workspaceRoot = await realpath(limits.workspaceRoot);
    const workingDirectory = limits.cwd ? await realpath(path.resolve(workspaceRoot, limits.cwd)) : workspaceRoot;
    const relativeWorkingDirectory = path.relative(workspaceRoot, workingDirectory);
    if (relativeWorkingDirectory === ".." || relativeWorkingDirectory.startsWith(".." + path.sep) || path.isAbsolute(relativeWorkingDirectory)) {
      throw new Error("Working directory escapes the configured workspace root.");
    }
    if (!(await stat(workingDirectory)).isDirectory()) throw new Error("Working directory must be a directory.");

    if (limits.allowNetwork !== true) {
      throw new Error(
        "Network isolation is not provided by ProcessSandbox. Use an OS/container sandbox that enforces network policy.",
      );
    }
    if (signal?.aborted) throw new Error("Process execution was aborted.");

    const child = spawn(command, args, {
      cwd: workingDirectory,
      shell: false,
      windowsHide: true,
      env: safeEnv(limits.allowedEnvironmentVariables),
      stdio: ["ignore", "pipe", "pipe"],
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      let capturedBytes = 0;
      let terminationError: Error | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const requestTermination = (error: Error) => {
        if (terminationError || settled) return;
        terminationError = error;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 250);
        forceKillTimer.unref?.();
      };
      const onAbort = () => requestTermination(new Error("Process execution was aborted."));

      const append = (target: Buffer[], chunk: Buffer) => {
        if (terminationError || settled) return;
        const remaining = maxOutputBytes - capturedBytes;
        if (chunk.length > remaining) {
          requestTermination(new Error("Process output exceeded the configured byte limit."));
          return;
        }
        target.push(chunk);
        capturedBytes += chunk.length;
      };

      const timeoutTimer = setTimeout(
        () => requestTermination(new Error("Process execution timed out.")),
        timeoutMs,
      );
      timeoutTimer.unref?.();

      child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("error", (error) => {
        rejectOnce(terminationError ?? error);
      });
      child.once("close", (code) => {
        if (terminationError) {
          rejectOnce(terminationError);
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code: code ?? 1,
        });
      });

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}


export interface ContainerSandboxOptions {
  /** Trusted OCI image pinned by immutable sha256 digest. The image must already exist locally. */
  image: string;
  /** Docker-compatible CLI executable. Defaults to "docker". */
  dockerPath?: string;
  /** Optional runner injection for deterministic tests. */
  runner?: ContainerCommandRunner;
}

export type ContainerCommandRunner = (
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

function runContainerCli(
  executable: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (options.signal?.aborted) return Promise.reject(new Error("Container execution was aborted."));
  const timeoutMs = positiveFinite(options.timeoutMs, "timeoutMs");
  const maxOutputBytes = positiveFinite(options.maxOutputBytes, "maxOutputBytes");
  const child = spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => new Set(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]).has(key.toUpperCase()))),
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let capturedBytes = 0;
    let terminationError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const terminate = (error: Error) => {
      if (terminationError || settled) return;
      terminationError = error;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 250);
      forceKillTimer.unref?.();
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      if (settled || terminationError) return;
      if (chunk.length > maxOutputBytes - capturedBytes) {
        terminate(new Error("Container CLI output exceeded the configured byte limit."));
        return;
      }
      target.push(chunk);
      capturedBytes += chunk.length;
    };
    const onAbort = () => terminate(new Error("Container execution was aborted."));
    const timeoutTimer = setTimeout(() => terminate(new Error("Container execution timed out.")), timeoutMs);
    timeoutTimer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => rejectOnce(terminationError ?? error));
    child.once("close", (code) => {
      if (terminationError) {
        rejectOnce(terminationError);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code: code ?? 1 });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

/**
 * Docker-backed isolation. Unlike ProcessSandbox, this applies container-level
 * filesystem, network, capability, process-count, memory, and CPU restrictions.
 * It is defense in depth, not a guarantee against kernel/container-runtime exploits.
 */
export class ContainerSandbox implements Sandbox {
  readonly isolation = "container" as const;
  private readonly dockerPath: string;
  private readonly runner: ContainerCommandRunner;

  constructor(private readonly options: ContainerSandboxOptions) {
    if (!/^.+@sha256:[a-f0-9]{64}$/i.test(options.image) || options.image.includes("\0")) {
      throw new Error("Container image must be pinned by an immutable sha256 digest.");
    }
    this.dockerPath = options.dockerPath ?? "docker";
    this.runner = options.runner ?? ((args, runnerOptions) => runContainerCli(this.dockerPath, args, runnerOptions));
  }

  async healthCheck(): Promise<void> {
    const limits = { timeoutMs: 10_000, maxOutputBytes: 4_096 };
    const daemon = await this.runner(["info", "--format", "{{.ServerVersion}}"], limits);
    if (daemon.code !== 0 || !daemon.stdout.trim()) {
      throw new Error("Container daemon is unavailable.");
    }
    const image = await this.runner(["image", "inspect", "--format", "{{.Id}}", this.options.image], limits);
    if (image.code !== 0 || !image.stdout.trim()) {
      throw new Error("Configured sandbox image is not preloaded on the runner host.");
    }
  }

  async run(
    command: string,
    args: string[],
    limits: SandboxLimits,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!command.trim() || command.includes("\0")) throw new Error("A valid container command is required.");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error("Command arguments must be strings without NUL bytes.");
    }
    if (!limits.workspaceRoot.trim()) throw new Error("A workspace root is required.");
    const timeoutMs = positiveFinite(limits.timeoutMs, "timeoutMs");
    const maxOutputBytes = positiveFinite(limits.maxOutputBytes, "maxOutputBytes");
    const { realpath, stat } = await import("node:fs/promises");
    const workspaceRoot = await realpath(limits.workspaceRoot);
    if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("Workspace root must be a directory.");
    const workingDirectory = limits.cwd ? await realpath(path.resolve(workspaceRoot, limits.cwd)) : workspaceRoot;
    const relativeWorkingDirectory = path.relative(workspaceRoot, workingDirectory);
    if (relativeWorkingDirectory === ".." || relativeWorkingDirectory.startsWith(".." + path.sep) || path.isAbsolute(relativeWorkingDirectory)) {
      throw new Error("Working directory escapes the configured workspace root.");
    }
    if (!(await stat(workingDirectory)).isDirectory()) throw new Error("Working directory must be a directory.");
    // Docker's --mount syntax uses commas as delimiters and has no portable escape.
    if (workspaceRoot.includes(",")) throw new Error("Workspace path cannot contain a comma for container mounting.");
    if (signal?.aborted) throw new Error("Container execution was aborted.");

    const containerName = `sofia-sandbox-${randomUUID()}`;
    const containerUserArgs = typeof process.getuid === "function" && typeof process.getgid === "function"
      ? ["--user", `${process.getuid()}:${process.getgid()}`]
      : [];
    const dockerArgs = [
      "run", "--rm", "--pull=never", "--name", containerName,
      ...containerUserArgs,
      "--network", limits.allowNetwork ? "bridge" : "none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=512m",
      "--cpus=1",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--mount", `type=bind,source=${workspaceRoot},target=/workspace`,
      "--workdir", path.posix.join("/workspace", relativeWorkingDirectory.split(path.sep).join("/")),
      this.options.image,
      command,
      ...args,
    ];
    try {
      // Preserve non-zero container exit codes for verification by the caller.
      return await this.runner(dockerArgs, { timeoutMs, maxOutputBytes, signal });
    } catch (error) {
      // Killing the Docker CLI on timeout/abort can leave the container running.
      // Best-effort cleanup is deliberately independent of the aborted task signal.
      await this.runner(["rm", "--force", containerName], { timeoutMs: 5_000, maxOutputBytes: 4_096 }).catch(() => undefined);
      throw error;
    }
  }
}


export interface RemoteSandboxOptions {
  /** HTTPS base URL of a trusted, separately operated sandbox runner. */
  endpoint: string;
  /** Host-only bearer token. Never expose it to model tools or project files. */
  token: string;
  /** Optional fetch implementation for deterministic tests. */
  fetcher?: typeof fetch;
  /** Maximum project snapshot size in bytes. Defaults to 100 MiB. */
  maxSnapshotBytes?: number;
}

/**
 * Sends a bounded project snapshot to a trusted remote runner over TLS.
 * The remote service MUST create a fresh container for every request, enforce
 * CPU/memory/PID/time/output limits, and apply its own egress firewall.
 * Only already-present regular files are accepted back; paths are validated
 * against the original snapshot before any local file is overwritten.
 */
export class RemoteSandbox implements Sandbox {
  readonly isolation = "container" as const;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly maxSnapshotBytes: number;

  constructor(private readonly options: RemoteSandboxOptions) {
    let parsed: URL;
    try { parsed = new URL(options.endpoint); } catch { throw new Error("Remote sandbox endpoint must be a valid URL."); }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("Remote sandbox endpoint must use HTTPS.");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Remote sandbox endpoint cannot contain credentials, query parameters, or fragments.");
    }
    if (typeof options.token !== "string" || options.token.length < 32 || /[\r\n]/.test(options.token)) {
      throw new Error("Remote sandbox token must contain at least 32 characters.");
    }
    this.endpoint = parsed.toString().replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 100 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxSnapshotBytes) || this.maxSnapshotBytes < 1) {
      throw new Error("Remote sandbox snapshot limit must be a positive safe integer.");
    }
  }

  async run(
    command: string,
    args: string[],
    limits: SandboxLimits,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!command.trim() || command.includes("\0")) throw new Error("A valid remote sandbox command is required.");
    if (!Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error("Remote sandbox arguments are invalid.");
    }
    const timeoutMs = positiveFinite(limits.timeoutMs, "timeoutMs");
    const maxOutputBytes = positiveFinite(limits.maxOutputBytes, "maxOutputBytes");
    if (signal?.aborted) throw new Error("Remote sandbox execution was aborted.");

    const { lstat, readdir, open: openFile, realpath, stat } = await import("node:fs/promises");
    const maxSnapshotBytes = this.maxSnapshotBytes;
    const root = await realpath(limits.workspaceRoot);
    if (!(await stat(root)).isDirectory()) throw new Error("Remote sandbox workspace must be a directory.");
    const files: Array<{ path: string; contentBase64: string }> = [];
    const known = new Map<string, string>();
    let totalBytes = 0;
    async function collect(directory: string, relative: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        const rel = relative ? path.join(relative, entry.name) : entry.name;
        const info = await lstat(full);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
        if (info.isDirectory()) { await collect(full, rel); continue; }
        if (files.length >= 10_000) throw new Error("Remote sandbox snapshot exceeds the file-count limit.");
        const handle = await openFile(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size > this.maxSnapshotBytes - totalBytes) {
            throw new Error("Remote sandbox snapshot exceeds its size limit.");
          }
          const data = await handle.readFile();
          if (data.length > maxSnapshotBytes - totalBytes) throw new Error("Remote sandbox snapshot exceeds its size limit.");
          totalBytes += data.length;
          const normalized = rel.split(path.sep).join("/");
          files.push({ path: normalized, contentBase64: data.toString("base64") });
          known.set(normalized, full);
        } finally { await handle.close(); }
      }
    }
    await collect(root, "");

    const relativeCwd = limits.cwd ? path.posix.normalize(limits.cwd.split(path.sep).join("/")) : ".";
    if ((limits.cwd?.includes("\0") ?? false) || relativeCwd === ".." || relativeCwd.startsWith("../") || path.posix.isAbsolute(relativeCwd)) {
      throw new Error("Remote sandbox working directory escapes its workspace.");
    }
    const requestId = randomUUID();
    const payload = {
      protocolVersion: 1,
      requestId,
      workspaceDigest: createHash("sha256").update(root).digest("hex"),
      command,
      args,
      cwd: relativeCwd,
      timeoutMs,
      maxOutputBytes,
      allowNetwork: limits.allowNetwork === true,
      files,
    };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs + 10_000);
    timer.unref?.();
    let response: Response;
    let result: {
      protocolVersion?: number;
      requestId?: string;
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      files?: unknown;
    };
    try {
      response = await this.fetcher(this.endpoint + "/v1/sandbox/execute", {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.options.token,
          "content-type": "application/json",
          "x-sofia-request-id": requestId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Remote sandbox runner rejected the request (HTTP " + response.status + ").");
      const responseLimit = Math.min(Number.MAX_SAFE_INTEGER, this.maxSnapshotBytes * 2 + maxOutputBytes * 4 + 1_048_576);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Remote sandbox runner returned an empty response body.");
      const responseChunks: Uint8Array[] = [];
      let responseBytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          responseBytes += chunk.value.byteLength;
          if (responseBytes > responseLimit) {
            await reader.cancel().catch(() => undefined);
            throw new Error("Remote sandbox response exceeded the configured byte limit.");
          }
          responseChunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const responseText = new TextDecoder().decode(Buffer.concat(responseChunks.map((chunk) => Buffer.from(chunk))));
      result = JSON.parse(responseText) as {
        protocolVersion?: number;
        requestId?: string;
        stdout?: unknown;
        stderr?: unknown;
        code?: unknown;
        files?: unknown;
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Remote sandbox request was aborted or timed out.", { cause: error });
      }
      if (error instanceof Error && error.message.startsWith("Remote sandbox")) throw error;
      throw new Error("Remote sandbox runner is unreachable or returned invalid JSON.", { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (result.protocolVersion !== 1 || result.requestId !== requestId ||
        typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
        !Number.isInteger(result.code) || (result.code as number) < 0 ||
        !Array.isArray(result.files)) {
      throw new Error("Remote sandbox runner returned an invalid protocol response.");
    }
    const outputBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (outputBytes > maxOutputBytes) throw new Error("Remote sandbox output exceeded the configured byte limit.");

    let returnedBytes = 0;
    const returnedPaths = new Set<string>();
    const updates: Array<{ target: string; data: Buffer }> = [];
    for (const item of result.files) {
      if (!item || typeof item !== "object") throw new Error("Remote sandbox returned an invalid file entry.");
      const file = item as { path?: unknown; contentBase64?: unknown };
      if (typeof file.path !== "string" || typeof file.contentBase64 !== "string" ||
          file.path.includes("\0") || file.path.includes("\\")) {
        throw new Error("Remote sandbox returned an invalid file path.");
      }
      const normalized = path.posix.normalize(file.path);
      if (normalized !== file.path || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized) || returnedPaths.has(normalized)) {
        throw new Error("Remote sandbox returned a path outside the project snapshot or a duplicate path.");
      }
      returnedPaths.add(normalized);
      const target = known.get(normalized);
      if (!target) throw new Error("Remote sandbox attempted to return a file outside the original snapshot.");
      const data = Buffer.from(file.contentBase64, "base64");
      if (data.toString("base64") !== file.contentBase64 || data.length > maxSnapshotBytes - returnedBytes) {
        throw new Error("Remote sandbox returned invalid or oversized file content.");
      }
      returnedBytes += data.length;
      updates.push({ target, data });
    }
    // Validate the entire response before applying any returned content.
    for (const update of updates) {
      const parent = await realpath(path.dirname(update.target));
      const relative = path.relative(root, parent);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new Error("Remote sandbox update escaped its workspace.");
      }
      const current = await lstat(update.target);
      if (!current.isFile() || current.isSymbolicLink()) throw new Error("Remote sandbox update target is no longer a regular file.");
    }
    for (const update of updates) {
      const handle = await open(update.target, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const current = await handle.stat();
        if (!current.isFile()) throw new Error("Remote sandbox update target is no longer a regular file.");
        await handle.truncate(0);
        await handle.writeFile(update.data);
      } finally {
        await handle.close();
      }
    }
    return { stdout: result.stdout, stderr: result.stderr, code: result.code as number };
  }
}
