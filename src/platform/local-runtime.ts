import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { detectPlatform, type WorkspaceRuntime } from "./runtime.js";

const execFileAsync = promisify(execFile);

export function createNodeWorkspaceRuntime(root = process.cwd()): WorkspaceRuntime {
  const platform = detectPlatform();

  const resolve = (p = ".") => {
    const absolute = path.resolve(root, p);
    const base = path.resolve(root);
    if (absolute !== base && !absolute.startsWith(base + path.sep)) {
      throw new Error("Workspace path escapes the configured root.");
    }
    return absolute;
  };

  const run = async (command: string, args: string[] = [], options: { cwd?: string } = {}) => {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd ? resolve(options.cwd) : root,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? String(error), code: e.code ?? 1 };
    }
  };

  return {
    platform,
    async cwd() { return root; },
    async readFile(p) { return fs.readFile(resolve(p), "utf8"); },
    async writeFile(p, content) {
      const target = resolve(p);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    },
    async listFiles(p = ".") {
      return fs.readdir(resolve(p));
    },
    async search(query, p = ".") {
      const target = resolve(p);
      const pattern = new RegExp(query);
      const matches: string[] = [];
      const ignored = new Set([".git", "node_modules", "dist", ".next", "coverage"]);

      const walk = async (directory: string, relative: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (ignored.has(entry.name)) continue;
          const absolute = path.join(directory, entry.name);
          const rel = relative ? path.join(relative, entry.name) : entry.name;

          if (entry.isDirectory()) {
            await walk(absolute, rel);
            continue;
          }

          try {
            const content = await fs.readFile(absolute, "utf8");
            content.split(/\r?\n/).forEach((line, index) => {
              if (pattern.test(line)) {
                pattern.lastIndex = 0;
                matches.push(rel + ":" + (index + 1) + ":" + line);
              }
            });
          } catch {
            // Binary/unreadable files are intentionally skipped.
          }
        }
      };

      await walk(target, "");
      return matches;
    },
    run,
    git: (args, options) => run("git", args, options),
  };
}
