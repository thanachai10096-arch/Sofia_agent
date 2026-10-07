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
      const result = await run("rg", ["--line-number", "--hidden", "--glob", "!.git", query, "."], { cwd: target });
      if (result.code === 0 || result.code === 1) {
        return result.stdout.split(/\r?\n/).filter(Boolean);
      }
      return result.stderr ? [result.stderr] : [];
    },
    run,
    git: (args, options) => run("git", args, options),
  };
}
