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

export interface RepositorySymbolReference {
  fromPath: string;
  symbol: string;
  targetPath?: string;
}

export interface RepositoryTestMapping {
  testPath: string;
  sourcePath: string;
  confidence: "high" | "medium" | "low";
}

export interface RepositoryImpact {
  path: string;
  score: number;
  reasons: string[];
}

export interface RepositoryMap {
  root: string;
  files: RepositoryFile[];
  symbols: RepositorySymbol[];
  dependencies: RepositoryDependency[];
  symbolReferences: RepositorySymbolReference[];
  testMappings: RepositoryTestMapping[];
  relevantFiles: string[];
  impactRanking: RepositoryImpact[];
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

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolveImport(from: string, specifier: string, files: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = normalize(from.split("/").slice(0, -1).concat(specifier.split("/")).join("/"));
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((ext) => base + ext),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((name) => base + "/" + name),
  ];
  return candidates.find((candidate) => files.has(candidate));
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
  return result.slice(0, 500);
}

function mapTests(files: RepositoryFile[]): RepositoryTestMapping[] {
  const source = new Set(files.filter((f) => f.kind === "source").map((f) => f.path));
  const result: RepositoryTestMapping[] = [];
  for (const test of files.filter((f) => f.kind === "test")) {
    const stem = test.path.replace(/\.(test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
    const candidates = [stem + ".ts", stem + ".tsx", stem + ".js", stem + ".jsx"];
    for (const candidate of candidates) {
      if (source.has(candidate)) {
        result.push({ testPath: test.path, sourcePath: candidate, confidence: "high" });
      }
    }
  }
  return result;
}

function buildImpact(
  files: RepositoryFile[],
  dependencies: RepositoryDependency[],
  mappings: RepositoryTestMapping[],
  wanted: string[],
): RepositoryImpact[] {
  const incoming = new Map<string, string[]>();
  for (const edge of dependencies) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.from);
    incoming.set(edge.to, list);
  }
  const mappedTests = new Map<string, string[]>();
  for (const mapping of mappings) {
    const list = mappedTests.get(mapping.sourcePath) ?? [];
    list.push(mapping.testPath);
    mappedTests.set(mapping.sourcePath, list);
  }

  return files
    .filter((file) => ["source", "test", "config"].includes(file.kind))
    .map((file) => {
      const reasons: string[] = [];
      const path = file.path.toLowerCase();
      const lexical = wanted.filter((token) => path.includes(token)).length;
      let score = lexical * 5;
      if (lexical) reasons.push("task-name match");
      const consumers = incoming.get(file.path) ?? [];
      if (consumers.length) {
        score += Math.min(10, consumers.length * 2);
        reasons.push(`used by ${consumers.length} file(s)`);
      }
      const tests = mappedTests.get(file.path) ?? [];
      if (tests.length) {
        score += 3;
        reasons.push(`covered by ${tests.length} test(s)`);
      }
      if (file.kind === "test") score += 1;
      return { path: file.path, score, reasons };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 40);
}

export async function buildRepositoryMap(
  runtime: WorkspaceRuntime,
  task?: string,
): Promise<RepositoryMap> {
  const root = await runtime.cwd();
  const paths = (await runtime.listFiles("."))
    .filter((path) => !path.split("/").some((part) => IGNORE.has(part)))
    .sort();
  const fileSet = new Set(paths);

  const files: RepositoryFile[] = [];
  const symbols: RepositorySymbol[] = [];
  const dependencies: RepositoryDependency[] = [];
  const symbolReferences: RepositorySymbolReference[] = [];
  const contents = new Map<string, string>();

  for (const path of paths) {
    const fileKind = kind(path);
    let size = 0;
    try {
      const content = await runtime.readFile(path);
      size = content.length;
      contents.set(path, content);
      symbols.push(...extractSymbols(path, content));
      if (SOURCE.test(path)) {
        for (const match of content.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
          const target = resolveImport(path, match[1]!, fileSet);
          if (target) dependencies.push({ from: path, to: target });
        }
        const localSymbols = symbols.filter((symbol) => symbol.path === path).map((symbol) => symbol.name);
        for (const symbol of localSymbols) {
          if (new RegExp(`\\b${symbol}\\b`).test(content)) {
            symbolReferences.push({ fromPath: path, symbol });
          }
        }
      }
    } catch {
      // Files can disappear between listing and inspection.
    }
    files.push({ path, kind: fileKind, size });
  }

  const mappings = mapTests(files);
  const wanted = tokens(task ?? "");
  const impactRanking = buildImpact(files, dependencies, mappings, wanted);
  const relevantFiles = impactRanking.slice(0, 40).map((item) => item.path);
  const summary = [
    `Repository: ${root}`,
    `Files: ${files.length} | source: ${files.filter((f) => f.kind === "source").length} | tests: ${files.filter((f) => f.kind === "test").length}`,
    `Symbols: ${symbols.length} | local dependencies: ${dependencies.length} | test mappings: ${mappings.length}`,
    relevantFiles.length ? "Impact-ranked files:\\n" + impactRanking.map((item) => `- ${item.path} (${item.score}): ${item.reasons.join(", ")}`).join("\\n") : "No task-specific files matched.",
  ].join("\n");

  return {
    root,
    files,
    symbols,
    dependencies,
    symbolReferences,
    testMappings: mappings,
    relevantFiles,
    impactRanking,
    summary,
  };
}

export function compactRepositoryMap(map: RepositoryMap): string {
  return [
    map.summary,
    map.symbols.length ? "Key symbols:\n" + map.symbols.slice(0, 80).map((s) => `- ${s.name} [${s.kind}] @ ${s.path}`).join("\n") : "",
    map.dependencies.length ? "Dependency edges:\n" + map.dependencies.slice(0, 80).map((d) => `- ${d.from} -> ${d.to}`).join("\n") : "",
  ].filter(Boolean).join("\n");
}
