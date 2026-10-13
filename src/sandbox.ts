import { spawn } from "node:child_process";

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  allowNetwork: boolean;
  workspaceRoot: string;
}

export interface Sandbox {
  readonly isolation: "policy" | "process" | "container";
  run(
    command: string,
    args: string[],
    limits: SandboxLimits,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }>;
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
function safeEnv(): NodeJS.ProcessEnv {
  const blocked = /(?:TOKEN|SECRET|PASSWORD|PRIVATE.?KEY|API.?KEY|AUTHORIZATION|AWS_ACCESS_KEY|AWS_SECRET|GITHUB_TOKEN|NPM_TOKEN)/i;
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !blocked.test(key)),
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

    if (limits.allowNetwork !== true) {
      throw new Error(
        "Network isolation is not provided by ProcessSandbox. Use an OS/container sandbox that enforces network policy.",
      );
    }
    if (signal?.aborted) throw new Error("Process execution was aborted.");

    const child = spawn(command, args, {
      cwd: limits.workspaceRoot,
      shell: false,
      windowsHide: true,
      env: safeEnv(),
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
    env: { PATH: process.env.PATH ?? "", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) },
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
    if (!/^.+@sha256:[a-f0-9]{64}$/i.test(options.image) || options.image.includes("\\0")) {
      throw new Error("Container image must be pinned by an immutable sha256 digest.");
    }
    this.dockerPath = options.dockerPath ?? "docker";
    this.runner = options.runner ?? ((args, runnerOptions) => runContainerCli(this.dockerPath, args, runnerOptions));
  }

  async run(
    command: string,
    args: string[],
    limits: SandboxLimits,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!command.trim() || command.includes("\\0")) throw new Error("A valid container command is required.");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\\0"))) {
      throw new Error("Command arguments must be strings without NUL bytes.");
    }
    if (!limits.workspaceRoot.trim()) throw new Error("A workspace root is required.");
    const timeoutMs = positiveFinite(limits.timeoutMs, "timeoutMs");
    const maxOutputBytes = positiveFinite(limits.maxOutputBytes, "maxOutputBytes");
    const { realpath, stat } = await import("node:fs/promises");
    const workspaceRoot = await realpath(limits.workspaceRoot);
    if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("Workspace root must be a directory.");
    // Docker's --mount syntax uses commas as delimiters and has no portable escape.
    if (workspaceRoot.includes(",")) throw new Error("Workspace path cannot contain a comma for container mounting.");
    if (signal?.aborted) throw new Error("Container execution was aborted.");

    const dockerArgs = [
      "run", "--rm", "--pull=never",
      "--network", limits.allowNetwork ? "bridge" : "none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=512m",
      "--cpus=1",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--mount", `type=bind,source=${workspaceRoot},target=/workspace,rw`,
      "--workdir", "/workspace",
      this.options.image,
      command,
      ...args,
    ];
    const result = await this.runner(dockerArgs, { timeoutMs, maxOutputBytes, signal });
    if (result.code !== 0) {
      // Preserve stdout/stderr for diagnostics while leaving non-zero exit codes visible to callers.
      return result;
    }
    return result;
  }
}
