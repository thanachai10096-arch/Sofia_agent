import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { detectPlatform, type WorkspaceRuntime } from "./runtime.js";

const execFileAsync = promisify(execFile);
const SECRET_NAME = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials(?:\.json)?|secrets?(?:\.json|\.ya?ml)?|.*\.(?:pem|key|p12|pfx))$/i;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".next", "coverage"]);
const BLOCKED_ENV = /(?:TOKEN|SECRET|PASSWORD|PRIVATE.?KEY|API.?KEY|AUTHORIZATION|AWS_ACCESS_KEY|AWS_SECRET|GITHUB_TOKEN|NPM_TOKEN|COOKIE|CREDENTIAL)/i;

function safeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !BLOCKED_ENV.test(key)),
  );
}

function isWithin(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(base + path.sep);
}

export function createNodeWorkspaceRuntime(root = process.cwd()): WorkspaceRuntime {
  const platform = detectPlatform();
  const base = path.resolve(root);

  const resolve = (p = "."): string => {
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
    const cwd = await contained(options.cwd ?? ".");
    const timeout = options.timeoutMs ?? 60_000;
    try {
      if (process.env.SOFIA_SANDBOX_MODE === "docker") {
        const image = process.env.SOFIA_SANDBOX_IMAGE || "node:22-alpine";
        const realRoot = await fs.realpath(base);
        const result = await execFileAsync("docker", [
          "run", "--rm",
          "--network", "none",
          "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges",
          "--read-only",
          "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
          "--pids-limit", "128",
          "--memory", "512m",
          "--cpus", "1",
          "-v", realRoot + ":/workspace:rw",
          "-w", path.posix.join("/workspace", path.relative(base, cwd).split(path.sep).join("/")),
          image, command, ...args,
        ], {
          cwd: base,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          timeout,
          env: safeEnv(),
        });
        return { stdout: result.stdout, stderr: result.stderr, code: 0 };
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
      return fs.readFile(await contained(p), "utf8");
    },
    async writeFile(p, content) {
      const target = await contained(p);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Re-check after creating parents to catch a symlink inserted during mkdir.
      await contained(path.relative(base, target));
      await fs.writeFile(target, content, "utf8");
    },
    async listFiles(p = ".") {
      return fs.readdir(await contained(p));
    },
    async search(query, p = ".") {
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
    git: async (args, options) => run("git", args, options),
  };
}
