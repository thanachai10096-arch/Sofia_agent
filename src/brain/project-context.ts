import type { WorkspaceRuntime } from "../platform/runtime.js";

export interface ProjectContextFile {
  path: string;
  content: string;
}

export interface ProjectContext {
  root: string;
  files: ProjectContextFile[];
  summary: string;
}

const CANDIDATES = [
  "SOFIA.md",
  "Sofia.md",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  "tsconfig.json",
] as const;

const MAX_FILE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 24_000;

function compact(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .slice(0, MAX_FILE_CHARS);
}

export async function discoverProjectContext(
  runtime: WorkspaceRuntime,
): Promise<ProjectContext> {
  const root = await runtime.cwd();
  const files: ProjectContextFile[] = [];
  let total = 0;

  for (const path of CANDIDATES) {
    if (total >= MAX_TOTAL_CHARS) break;
    try {
      const content = compact(await runtime.readFile(path));
      if (!content.trim()) continue;
      const remaining = MAX_TOTAL_CHARS - total;
      const selected = content.slice(0, remaining);
      files.push({ path, content: selected });
      total += selected.length;
    } catch {
      // Missing context files are normal.
    }
  }

  const summary = files.length
    ? files.map((file) => `--- ${file.path} ---\n${file.content}`).join("\n\n")
    : "No standard project context files were found.";

  return { root, files, summary };
}

export function compactProjectContext(context: ProjectContext): string {
  return context.summary.slice(0, MAX_TOTAL_CHARS);
}
