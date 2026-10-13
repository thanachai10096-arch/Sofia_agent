import { spawn } from "node:child_process";
import path from "node:path";

const MAX_OUTPUT_CHARS = 2_000_000;

/**
 * This helper provides bounded process execution, not OS/container isolation.
 * Network access cannot be disabled by Node's spawn options; callers must
 * explicitly acknowledge unrestricted networking or use a real OS/container
 * sandbox for network-disabled execution.
 */
export type SandboxOptions = {
  workspaceRoot: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  /** Explicit acknowledgement that this process may access the network. */
  network: boolean;
};

function appendBounded(
  current: string,
  chunk: Buffer | string,
  kill: () => void,
): string {
  const value = chunk.toString();
  const remaining = MAX_OUTPUT_CHARS - current.length;
  if (remaining <= 0) {
    kill();
    return current;
  }
  if (value.length > remaining) {
    kill();
    return current + value.slice(0, remaining);
  }
  return current + value;
}

export function sandboxCommand(
  options: SandboxOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (path.isAbsolute(options.command) || options.command.includes("..")) {
    return Promise.reject(new Error("Unsafe sandbox command."));
  }
  if (options.network !== true) {
    return Promise.reject(
      new Error(
        "Network isolation is not provided by this process helper. Use an OS/container sandbox for network-disabled execution.",
      ),
    );
  }

  const childArgs = options.args ?? [];
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, childArgs, {
      cwd: options.workspaceRoot,
      shell: false,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishWithError(new Error("Sandbox timeout"));
    }, options.timeoutMs ?? 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, () => child.kill("SIGKILL"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, () => child.kill("SIGKILL"));
    });
    child.on("error", (error) => {
      finishWithError(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
