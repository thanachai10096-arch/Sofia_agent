import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type InputRecord = Record<string, unknown>;
function record(input: unknown): InputRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Input must be an object.");
  return input as InputRecord;
}
function text(value: unknown, key: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(key + " must be non-empty text within the length limit.");
  return value.trim();
}
function stringList(value: unknown, key: string, max = 200): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim() || item.length > 1_000)) throw new TypeError(key + " must be a bounded list of non-empty strings.");
  return [...new Set(value.map(item => (item as string).trim()))];
}
function objects(value: unknown, key: string, max = 500): InputRecord[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new TypeError(key + " must be a bounded list of objects.");
  return value as InputRecord[];
}

/** Builds a repository graph from supplied paths and edges; it does not inspect the filesystem. */
export const repositoryMapper = (input: unknown) => {
  const value = record(input);
  const paths = stringList(value.paths, "paths", 2_000);
  const edges = objects(value.dependencies ?? [], "dependencies", 5_000).map((edge, index) => {
    const from = text(edge.from, "dependencies[" + index + "].from", 1_000);
    const to = text(edge.to, "dependencies[" + index + "].to", 1_000);
    return { from, to };
  });
  const known = new Set(paths);
  const unknownEndpoints = edges.filter(edge => !known.has(edge.from) || !known.has(edge.to));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const path of paths) { incoming.set(path, []); outgoing.set(path, []); }
  for (const edge of edges) {
    if (known.has(edge.from) && known.has(edge.to)) {
      outgoing.get(edge.from)!.push(edge.to);
      incoming.get(edge.to)!.push(edge.from);
    }
  }
  return {
    files: paths.map(path => ({ path, imports: [...new Set(outgoing.get(path))].sort(), importedBy: [...new Set(incoming.get(path))].sort() })),
    edgeCount: edges.length,
    unknownEndpoints,
    complete: unknownEndpoints.length === 0,
    filesystemInspected: false,
  };
};

/** Searches only the supplied snippets using deterministic token overlap, not embeddings. */
export const codebaseSemanticSearch = (input: unknown) => {
  const value = record(input);
  const query = text(value.query, "query", 1_000);
  const documents = objects(value.documents, "documents", 500).map((doc, index) => ({
    id: text(doc.id, "documents[" + index + "].id", 200),
    path: text(doc.path, "documents[" + index + "].path", 1_000),
    content: text(doc.content, "documents[" + index + "].content", 20_000),
  }));
  const tokens = (value: string) => [...new Set(value.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? [])];
  const queryTokens = tokens(query);
  const results = documents.map(doc => {
    const docTokens = new Set(tokens(doc.path + " " + doc.content));
    const matched = queryTokens.filter(token => docTokens.has(token));
    return { id: doc.id, path: doc.path, matchedTerms: matched, score: queryTokens.length ? matched.length / queryTokens.length : 0 };
  }).filter(result => result.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { query, results, method: "token-overlap", semanticModelUsed: false, sourceCoverage: "supplied-documents-only" };
};

/** Turns a human goal into a bounded plan skeleton with explicit criteria and dependencies. */
export const implementationPlanner = (input: unknown) => {
  const value = record(input);
  const goal = text(value.goal, "goal");
  const files = stringList(value.candidateFiles ?? [], "candidateFiles", 100);
  const criteria = stringList(value.acceptanceCriteria, "acceptanceCriteria", 50);
  const constraints = stringList(value.constraints ?? [], "constraints", 50);
  if (criteria.length === 0) throw new TypeError("At least one acceptance criterion is required.");
  const steps = [
    { id: "inspect", action: "Inspect existing implementation, interfaces, tests, and current changes", dependsOn: [] as string[] },
    { id: "plan", action: "Map acceptance criteria to the smallest additive change", dependsOn: ["inspect"] },
    { id: "implement", action: "Implement backward-compatible changes in reviewed scope", dependsOn: ["plan"] },
    { id: "verify", action: "Run focused tests, typecheck, and relevant regression checks", dependsOn: ["implement"] },
    { id: "review", action: "Review final diff, security boundaries, and evidence for every criterion", dependsOn: ["verify"] },
  ];
  return { goal, candidateFiles: files, acceptanceCriteria: criteria, constraints, steps, planOnly: true, editsMade: false };
};

/** Groups supplied TypeScript diagnostics by file and severity; it does not run tsc. */
export const typeScriptDiagnosticTriage = (input: unknown) => {
  const value = record(input);
  const diagnostics = objects(value.diagnostics, "diagnostics", 2_000).map((item, index) => {
    const file = text(item.file, "diagnostics[" + index + "].file", 1_000);
    const code = text(item.code, "diagnostics[" + index + "].code", 80);
    const message = text(item.message, "diagnostics[" + index + "].message", 4_000);
    const severity = item.severity ?? "error";
    if (severity !== "error" && severity !== "warning" && severity !== "info") throw new TypeError("severity must be error, warning, or info.");
    return { file, code, message, severity };
  });
  const byFile = new Map<string, typeof diagnostics>();
  for (const diagnostic of diagnostics) byFile.set(diagnostic.file, [...(byFile.get(diagnostic.file) ?? []), diagnostic]);
  return {
    diagnostics,
    byFile: [...byFile.entries()].map(([file, items]) => ({ file, count: items.length, diagnostics: items })),
    errorCount: diagnostics.filter(item => item.severity === "error").length,
    warningCount: diagnostics.filter(item => item.severity === "warning").length,
    compilerExecuted: false,
  };
};

/** Proposes a refactor sequence from caller-supplied modules and tests; it does not modify code. */
export const refactoringPlanner = (input: unknown) => {
  const value = record(input);
  const target = text(value.target, "target");
  const modules = stringList(value.modules, "modules", 100);
  const tests = stringList(value.tests, "tests", 200);
  const risks = stringList(value.risks ?? [], "risks", 100);
  return {
    target, modules, tests, risks,
    sequence: [
      { step: 1, action: "Capture baseline behavior and current test results", evidenceRequired: true },
      { step: 2, action: "Refactor one module at a time with unchanged public interfaces", evidenceRequired: true },
      { step: 3, action: "Run focused tests after each module", evidenceRequired: true },
      { step: 4, action: "Run regression suite and review API/security diff", evidenceRequired: true },
    ],
    safeToApplyAutomatically: false,
  };
};

export function registerVerifiedCodingPlanningSkills(registry: AdvancedSkillRegistry): string[] {
  const entries: Array<{ id: string; handler: AdvancedSkillHandler }> = [
    { id: "coding.01", handler: repositoryMapper },
    { id: "coding.02", handler: codebaseSemanticSearch },
    { id: "coding.04", handler: implementationPlanner },
    { id: "coding.06", handler: typeScriptDiagnosticTriage },
    { id: "coding.09", handler: refactoringPlanner },
  ];
  const registered: string[] = [];
  for (const entry of entries) {
    const definition = getAdvancedSkill(entry.id);
    if (definition?.status === "verified") {
      registry.register(definition, entry.handler);
      registered.push(entry.id);
    }
  }
  return registered;
}
