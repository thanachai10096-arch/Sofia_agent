import type { WorkspaceRuntime } from "../platform/runtime.js";

export interface RepositoryFile {
  path: string;
  kind: "source" | "test" | "config" | "docs" | "asset" | "unknown";
  size: number;
}

export interface RepositorySymbol {
  path: string;
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "export";
}

export interface RepositoryDependency {
  from: string;
  to: string;
}

export interface RepositoryMap {
  root: string;
  files: RepositoryFile[];
  symbols: RepositorySymbol[];
  dependencies: RepositoryDependency[];
  relevantFiles: string[];
  summary: string;
}

const IGNORE = new Set([".git", "node_modules", "dist", ".next", "coverage"]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /(?:\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const CONFIG = /(?:package\.json|tsconfig(?:\.[^.]+)?\.json|vite\.config\.|next\.config\.|eslint\.|prettier\.)/;

function kind(path: string): RepositoryFile["kind"] {
  if (TEST.test(path)) return "test";
  if (SOURCE.test(path)) return "source";
  if (CONFIG.test(path)) return "config";
  if (/\.(md|mdx|txt)$/i.test(path)) return "docs";
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(path)) return "asset";
  return "unknown";
}

function tokens(task: string): string[] {
  return [...new Set(task.toLowerCase().match(/[a-z0-9_$-]{3,}/g) ?? [])]
    .filter((token) => !["the", "and", "for", "with", "that", "this"].includes(token));
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = from.split("/").slice(0, -1).concat(specifier.split("/")).join("/");
  const normalized = base.replace(/\/\.\//g, "/").replace(/^\.\//, "");
  return normalized;
}

function extractSymbols(path: string, content: string): RepositorySymbol[] {
  if (!SOURCE.test(path) || TEST.test(path)) return [];
  const result: RepositorySymbol[] = [];
  const patterns: Array<[RepositorySymbol["kind"], RegExp]> = [
    ["function", /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g],
    ["class", /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g],
    ["interface", /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g],
    ["type", /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/g],
    ["const", /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/g],
  ];
  for (const [symbolKind, pattern] of patterns) {
    for (const match of content.matchAll(pattern)) {
      result.push({ path, name: match[1]!, kind: symbolKind });
    }
  }
  return result;
}

export async function buildRepositoryMap(
  runtime: WorkspaceRuntime,
  task?: string,
): Promise<RepositoryMap> {
  const root = await runtime.cwd();
  const paths = (await runtime.listFiles("."))
    .filter((path) => !path.split("/").some((part) => IGNORE.has(part)))
    .sort();

  const files: RepositoryFile[] = [];
  const symbols: RepositorySymbol[] = [];
  const dependencies: RepositoryDependency[] = [];
  const contents = new Map<string, string>();

  for (const path of paths) {
    const file = kind(path);
    let size = 0;
    try {
      const content = await runtime.readFile(path);
      size = content.length;
      contents.set(path, content);
      symbols.push(...extractSymbols(path, content).slice(0, 500));
      if (SOURCE.test(path)) {
        for (const match of content.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
          const target = resolveImport(path, match[1]!);
          if (target) dependencies.push({ from: path, to: target });
        }
      }
    } catch {
      // Files can disappear between listing and inspection.
    }
    files.push({ path, kind: file, size });
  }

  const wanted = tokens(task ?? "");
  const scores = files
    .filter((file) => file.kind === "source" || file.kind === "test" || file.kind === "config")
    .map((file) => {
      const haystack = file.path.toLowerCase() + "\n" + (contents.get(file.path) ?? "").slice(0, 12000).toLowerCase();
      const score = wanted.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { path: file.path, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const relevantFiles = scores.slice(0, 40).map((item) => item.path);
  const summary = [
    `Repository: ${root}`,
    `Files: ${files.length} | source: ${files.filter((f) => f.kind === "source").length} | tests: ${files.filter((f) => f.kind === "test").length}`,
    `Symbols: ${symbols.length} | local dependencies: ${dependencies.length}`,
    relevantFiles.length ? "Relevant files:\n" + relevantFiles.map((p) => `- ${p}`).join("\n") : "No task-specific files matched.",
  ].join("\n");

  return { root, files, symbols, dependencies, relevantFiles, summary };
}

export function compactRepositoryMap(map: RepositoryMap): string {
  return map.summary;
}
