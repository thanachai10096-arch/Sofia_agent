import { completionVerifier } from "./core-handlers.js";
import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type InputRecord = Record<string, unknown>;
function record(input: unknown): InputRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Skill input must be an object.");
  return input as InputRecord;
}
function listOfText(value: unknown, key: string, max = 200): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`Skill input ${key} must be an array of at most ${max} non-empty strings.`);
  }
  return [...new Set(value.map(item => (item as string).trim()))];
}
function objectList(value: unknown, key: string, max = 500): InputRecord[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new TypeError(`Skill input ${key} must be an array of at most ${max} objects.`);
  }
  return value as InputRecord[];
}

/** Computes reverse dependency impact and mapped tests without claiming to read the filesystem. */
export const changeImpactAnalyzer = (input: unknown) => {
  const value = record(input);
  const changedFiles = listOfText(value.changedFiles, "changedFiles");
  const dependencies = objectList(value.dependencies ?? [], "dependencies").map((edge, index) => {
    if (typeof edge.from !== "string" || !edge.from.trim() || typeof edge.to !== "string" || !edge.to.trim()) {
      throw new TypeError(`dependencies[${index}] needs from and to paths.`);
    }
    return { from: edge.from.trim(), to: edge.to.trim() };
  });
  const testMappings = objectList(value.testMappings ?? [], "testMappings").map((mapping, index) => {
    if (typeof mapping.testPath !== "string" || !mapping.testPath.trim() ||
        typeof mapping.sourcePath !== "string" || !mapping.sourcePath.trim()) {
      throw new TypeError(`testMappings[${index}] needs testPath and sourcePath.`);
    }
    return { testPath: mapping.testPath.trim(), sourcePath: mapping.sourcePath.trim() };
  });
  const affected = new Set(changedFiles);
  const reasons = new Map<string, string[]>();
  for (const path of changedFiles) reasons.set(path, ["directly changed"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of dependencies) {
      if (affected.has(edge.to) && !affected.has(edge.from)) {
        affected.add(edge.from);
        reasons.set(edge.from, [`depends on affected file ${edge.to}`]);
        changed = true;
      }
    }
  }
  const impacted = [...affected].map(path => ({ path, reasons: reasons.get(path) ?? ["dependency impact"] }));
  const selectedTests = [...new Set(testMappings.filter(mapping => affected.has(mapping.sourcePath)).map(mapping => mapping.testPath))].sort();
  return {
    changedFiles,
    impactedFiles: impacted,
    selectedTests,
    impactedFileCount: impacted.length,
    directChangeCount: changedFiles.length,
    transitiveImpactCount: Math.max(0, impacted.length - changedFiles.length),
  };
};

const TEST_LAYERS: Record<string, Array<{ layer: string; rationale: string }>> = {
  feature: [
    { layer: "unit", rationale: "Cover new behavior and edge cases." },
    { layer: "integration", rationale: "Verify the feature against its real dependencies." },
    { layer: "acceptance", rationale: "Check every user-visible acceptance criterion." },
  ],
  bug: [
    { layer: "regression", rationale: "Add a test that fails on the reported bug before the fix." },
    { layer: "unit", rationale: "Cover the smallest failing behavior and boundary cases." },
    { layer: "integration", rationale: "Check adjacent components for regressions." },
  ],
  refactor: [
    { layer: "unit", rationale: "Preserve existing behavior at component boundaries." },
    { layer: "regression", rationale: "Run tests covering callers and downstream dependencies." },
    { layer: "build", rationale: "Check types, imports, and packaging after structural changes." },
  ],
  security: [
    { layer: "negative", rationale: "Prove unauthorized and malformed actions are rejected." },
    { layer: "boundary", rationale: "Test path, scope, timeout, and input limits." },
    { layer: "secret-redaction", rationale: "Ensure credentials never appear in outputs or audit records." },
    { layer: "integration", rationale: "Verify controls cannot be bypassed through another execution path." },
  ],
  docs: [
    { layer: "link-check", rationale: "Verify referenced files and links exist." },
    { layer: "example-check", rationale: "Run commands and examples where practical." },
  ],
  dependency: [
    { layer: "typecheck", rationale: "Catch incompatible APIs and type changes." },
    { layer: "unit", rationale: "Verify dependent behavior still works." },
    { layer: "build", rationale: "Verify dependency resolution and packaging." },
  ],
};

/** Proposes a test plan; it does not execute tests. */
export const testStrategyBuilder = (input: unknown) => {
  const value = record(input);
  const changeType = value.changeType;
  if (typeof changeType !== "string" || !Object.prototype.hasOwnProperty.call(TEST_LAYERS, changeType)) {
    throw new TypeError("changeType must be feature, bug, refactor, security, docs, or dependency.");
  }
  const changedFiles = listOfText(value.changedFiles ?? [], "changedFiles");
  const acceptanceCriteria = listOfText(value.acceptanceCriteria ?? [], "acceptanceCriteria");
  return {
    changeType,
    changedFiles,
    acceptanceCriteria,
    recommendedLayers: TEST_LAYERS[changeType]!,
    acceptanceCriteriaCount: acceptanceCriteria.length,
    requiresExecutionEvidence: true,
    executed: false,
  };
};

/** Selects mapped tests for changed source paths; unknown mappings are reported, not guessed. */
export const regressionTestSelector = (input: unknown) => {
  const value = record(input);
  const changedFiles = listOfText(value.changedFiles, "changedFiles");
  const testMappings = objectList(value.testMappings ?? [], "testMappings").map((mapping, index) => {
    if (typeof mapping.testPath !== "string" || !mapping.testPath.trim() ||
        typeof mapping.sourcePath !== "string" || !mapping.sourcePath.trim()) {
      throw new TypeError(`testMappings[${index}] needs testPath and sourcePath.`);
    }
    return { testPath: mapping.testPath.trim(), sourcePath: mapping.sourcePath.trim() };
  });
  const selected = [...new Set(testMappings.filter(mapping => changedFiles.includes(mapping.sourcePath)).map(mapping => mapping.testPath))].sort();
  const unmapped = changedFiles.filter(path => !testMappings.some(mapping => mapping.sourcePath === path));
  return { selectedTests: selected, unmappedChangedFiles: unmapped, selectionComplete: unmapped.length === 0 };
};

/** Adapts the evidence-backed completion verifier to the testing catalog entry. */
export const acceptanceCriteriaVerifier = completionVerifier;

/** Summarizes supplied static-analysis results; it never claims to run the checks itself. */
export const staticAnalysisCoordinator = (input: unknown) => {
  const value = record(input);
  const checks = objectList(value.checks, "checks", 100).map((check, index) => {
    if (typeof check.name !== "string" || !check.name.trim() || typeof check.passed !== "boolean") {
      throw new TypeError(`checks[${index}] needs a name and boolean passed field.`);
    }
    if (check.passed && (typeof check.evidenceId !== "string" || !check.evidenceId.trim())) {
      throw new TypeError(`checks[${index}] needs evidenceId when passed is true.`);
    }
    return {
      name: check.name.trim(),
      passed: check.passed,
      ...(typeof check.evidenceId === "string" ? { evidenceId: check.evidenceId.slice(0, 200) } : {}),
      ...(typeof check.detail === "string" ? { detail: check.detail.slice(0, 500) } : {}),
    };
  });
  if (checks.length === 0) throw new TypeError("Skill input checks must contain at least one check.");
  return {
    ready: checks.every(check => check.passed),
    checks,
    passedCount: checks.filter(check => check.passed).length,
    failedCount: checks.filter(check => !check.passed).length,
    executedByThisSkill: false,
  };
};

export function registerVerifiedQualitySkills(registry: AdvancedSkillRegistry): string[] {
  const handlers: Array<{ id: string; handler: AdvancedSkillHandler }> = [
    { id: "coding.03", handler: changeImpactAnalyzer },
    { id: "testing.01", handler: testStrategyBuilder },
    { id: "testing.05", handler: regressionTestSelector },
    { id: "testing.08", handler: acceptanceCriteriaVerifier },
    { id: "testing.09", handler: staticAnalysisCoordinator },
  ];
  const registered: string[] = [];
  for (const item of handlers) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}
