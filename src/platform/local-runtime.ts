import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { detectPlatform, type WorkspaceRuntime } from "./runtime.js";
import { ContainerSandbox } from "../sandbox.js";

const execFileAsync = promisify(execFile);
const SECRET_NAME = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials(?:\.json)?|secrets?(?:\.json|\.ya?ml)?|.*\.(?:pem|key|p12|pfx))$/i;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".next", "coverage"]);
const BLOCKED_ENV = /(?:TOKEN|SECRET|PASSWORD|PRIVATE.?KEY|API.?KEY|AUTHORIZATION|AWS_ACCESS_KEY|AWS_SECRET|GITHUB_TOKEN|NPM_TOKEN|COOKIE|CREDENTIAL)/i;

function safeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !BLOCKED_ENV.test(key)),
  );
}

const GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "branch", "tag",
  "add", "commit", "restore", "switch", "checkout", "stash", "reset", "clean", "merge",
  "rebase", "remote", "fetch", "pull", "push", "clone", "apply",
]);
const GIT_DANGEROUS_ARG = /^--(?:upload-pack|receive-pack|exec|exec-path|ext-diff|textconv|config-env|unsafe-paths)(?:=|$)/i;

/** Only allow known Git subcommands; reject global options that can alter execution/configuration. */
export function assertSafeGitArgs(args: readonly string[]): void {
  const sub = args[0];
  if (typeof sub !== "string" || sub.startsWith("-") || !GIT_SUBCOMMANDS.has(sub)) {
    throw new Error("Git subcommand is not allowed by Sofia runtime policy.");
  }
  if (args.some((arg) => GIT_DANGEROUS_ARG.test(arg))) {
    throw new Error("Git option is not allowed by Sofia runtime policy.");
  }
}

function isWithin(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(base + path.sep);
}

function isSensitivePath(p: string): boolean {
  const segments = p.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) =>
    segment.toLowerCase() === ".git" ||
    segment.toLowerCase() === "node_modules" ||
    SECRET_NAME.test(segment) ||
    segment.toLowerCase() === ".sofia" && segments.some((part) => part.toLowerCase() === "secrets")
  );
}

function assertPathAllowed(p: string): void {
  if (isSensitivePath(p)) throw new Error("Access to sensitive workspace paths is blocked by Sofia runtime policy.");
}

export function createNodeWorkspaceRuntime(root = process.cwd()): WorkspaceRuntime {
  const platform = detectPlatform();
  const base = path.resolve(root);

  const resolve = (p = "."): string => {
    assertPathAllowed(p);
    const absolute = path.resolve(base, p);
    if (!isWithin(base, absolute)) {
      throw new Error("Workspace path escapes the configured root.");
    }
    return absolute;
  };

  // Resolve the deepest existing ancestor so symlinks cannot lexically escape
  // the workspace. This reduces traversal risk; it cannot eliminate OS-level
  // TOCTOU races if an untrusted process can mutate workspace paths concurrently.
  const contained = async (p = "."): Promise<string> => {
    const absolute = resolve(p);
    const realBase = await fs.realpath(base);
    let probe = absolute;

    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (!isWithin(realBase, real)) {
          throw new Error("Workspace path escapes the configured root.");
        }
        return absolute;
      } catch (error) {
        if (error instanceof Error && error.message === "Workspace path escapes the configured root.") {
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
  };

  const run: WorkspaceRuntime["run"] = async (command, args = [], options = {}) => {
    const shellEnabled = /^(?:true|1|yes|on)$/i.test((process.env.SOFIA_ALLOW_SHELL ?? "").trim());
    if (shellEnabled && process.env.SOFIA_SANDBOX_MODE !== "docker") {
      throw new Error("SOFIA_ALLOW_SHELL requires SOFIA_SANDBOX_MODE=docker so shell execution is isolated.");
    }
    const cwd = await contained(options.cwd ?? ".");
    const timeout = options.timeoutMs ?? 60_000;
    try {
      if (process.env.SOFIA_SANDBOX_MODE === "docker") {
        const image = process.env.SOFIA_SANDBOX_IMAGE;
        if (!image) {
          throw new Error("SOFIA_SANDBOX_IMAGE must name a preloaded SHA-256-pinned container image when SOFIA_SANDBOX_MODE=docker.");
        }
        const sandbox = new ContainerSandbox({ image });
        return await sandbox.run(command, args, {
          workspaceRoot: base,
          cwd: path.relative(base, cwd),
          timeoutMs: timeout,
          maxOutputBytes: 8 * 1024 * 1024,
          allowNetwork: false,
        });
      }

      const result = await execFileAsync(command, args, {
        cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout,
        env: safeEnv(),
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const e = error as { code?: string | number; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
      const numericCode = typeof e.code === "number" ? e.code : undefined;
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(error),
        code: numericCode ?? (e.killed || e.signal === "SIGTERM" ? 124 : 1),
      };
    }
  };

  return {
    platform,
    async cwd() {
      return base;
    },
    async readFile(p) {
      assertPathAllowed(p);
      return fs.readFile(await contained(p), "utf8");
    },
    async writeFile(p, content) {
      assertPathAllowed(p);
      const target = await contained(p);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Re-check after creating parents to catch a symlink inserted during mkdir.
      await contained(path.relative(base, target));
      await fs.writeFile(target, content, "utf8");
    },
    async listFiles(p = ".") {
      assertPathAllowed(p);
      return fs.readdir(await contained(p));
    },
    async search(query, p = ".") {
      assertPathAllowed(p);
      const target = await contained(p);
      let pattern: RegExp;
      try {
        pattern = new RegExp(query);
      } catch (error) {
        throw new Error("Invalid search pattern: " + (error instanceof Error ? error.message : String(error)));
      }

      const matches: string[] = [];
      const walk = async (directory: string, relative: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (IGNORED_DIRS.has(entry.name) || entry.isSymbolicLink() || SECRET_NAME.test(entry.name)) continue;
          const absolute = path.join(directory, entry.name);
          const rel = relative ? path.join(relative, entry.name) : entry.name;
          if (entry.isDirectory()) {
            await walk(absolute, rel);
            continue;
          }
          try {
            const content = await fs.readFile(absolute, "utf8");
            content.split(/\r?\n/).forEach((line, index) => {
              pattern.lastIndex = 0;
              if (pattern.test(line)) matches.push(rel + ":" + (index + 1) + ":" + line);
            });
          } catch {
            // Ignore binary, unreadable, and concurrently removed files.
          }
        }
      };

      await walk(target, "");
      return matches;
    },
    run,
    git: async (args, options = {}) => {
      assertSafeGitArgs(args);
      if (["clone", "fetch", "pull", "push"].includes(args[0] ?? "")) {
        throw new Error("Network-capable Git operations require a dedicated allowlisted network transport and are disabled in the local runtime.");
      }
      const shellEnabled = /^(?:true|1|yes|on)$/i.test((process.env.SOFIA_ALLOW_SHELL ?? "").trim());
      if (shellEnabled && process.env.SOFIA_SANDBOX_MODE !== "docker") {
        throw new Error("SOFIA_ALLOW_SHELL requires SOFIA_SANDBOX_MODE=docker so Git execution is isolated.");
      }
      const cwd = await contained(options.cwd ?? ".");
      if (process.env.SOFIA_ALLOW_SHELL && /^(?:true|1|yes|on)$/i.test(process.env.SOFIA_ALLOW_SHELL.trim()) &&
          process.env.SOFIA_SANDBOX_MODE === "docker") {
        const image = process.env.SOFIA_SANDBOX_IMAGE;
        if (!image) throw new Error("SOFIA_SANDBOX_IMAGE must name a preloaded SHA-256-pinned container image when shell execution is enabled.");
        const sandbox = new ContainerSandbox({ image });
        return await sandbox.run("git", args, {
          workspaceRoot: base,
          cwd: path.relative(base, cwd),
          timeoutMs: options.timeoutMs ?? 60_000,
          maxOutputBytes: 8 * 1024 * 1024,
          allowNetwork: false,
        });
      }
      try {
        const result = await execFileAsync("git", args, {
          cwd,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          timeout: options.timeoutMs ?? 60_000,
          env: safeEnv(),
        });
        return { stdout: result.stdout, stderr: result.stderr, code: 0 };
      } catch (error) {
        const e = error as { code?: string | number; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
        const numericCode = typeof e.code === "number" ? e.code : undefined;
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? String(error),
          code: numericCode ?? (e.killed || e.signal === "SIGTERM" ? 124 : 1),
        };
      }
    },
  };
}
