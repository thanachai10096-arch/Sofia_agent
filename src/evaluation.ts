import type { AgentRequest, AgentResult } from "./agent/types.js";
import type { AcceptanceCriterion, CompletionReport, VerificationResult } from "./brain/types.js";

export interface EvaluationExpectations {
  outputIncludes?: string[];
  outputEquals?: string;
  changedFilesInclude?: string[];
  minSteps?: number;
  maxSteps?: number;
}

export interface EvaluationCase {
  id: string;
  task: string;
  acceptanceCriteria: string[];
  /** Executable, evidence-producing probes. Natural-language criteria alone cannot prove success. */
  probes?: AcceptanceCriterion[];
  expected?: EvaluationExpectations;
  tags?: string[];
}

export interface EvaluationResult {
  caseId: string;
  passed: boolean;
  score: number;
  durationMs: number;
  details: string;
}

export interface EvaluationRunner {
  run(testCase: EvaluationCase): Promise<EvaluationResult>;
}

function expectedChecks(testCase: EvaluationCase, result: AgentResult): Array<{ label: string; passed: boolean }> {
  const expected = testCase.expected;
  if (!expected) return [];
  const report = result.brainReport;
  const checks: Array<{ label: string; passed: boolean }> = [];
  if (expected.outputEquals !== undefined) {
    checks.push({ label: "output equals expected value", passed: result.output === expected.outputEquals });
  }
  for (const text of expected.outputIncludes ?? []) {
    checks.push({ label: "output includes " + JSON.stringify(text), passed: result.output.includes(text) });
  }
  for (const file of expected.changedFilesInclude ?? []) {
    checks.push({ label: "changed files include " + JSON.stringify(file), passed: Boolean(report?.changedFiles.includes(file)) });
  }
  if (expected.minSteps !== undefined) {
    checks.push({ label: "steps >= " + expected.minSteps, passed: result.steps >= expected.minSteps });
  }
  if (expected.maxSteps !== undefined) {
    checks.push({ label: "steps <= " + expected.maxSteps, passed: result.steps <= expected.maxSteps });
  }
  return checks;
}

function criterionOutcome(
  criterion: AcceptanceCriterion,
  report: CompletionReport | undefined,
): { passed: boolean; detail: string } {
  const verification: VerificationResult | undefined = report?.verification.find(
    (item) => item.criterionId === criterion.id,
  );
  if (!verification) {
    return { passed: false, detail: "missing verification result for " + criterion.id };
  }
  if (!verification.passed) {
    return { passed: false, detail: criterion.id + " failed: " + verification.detail };
  }
  if (verification.evidenceIds.length === 0 || !verification.workspaceRevision) {
    return { passed: false, detail: criterion.id + " has no verifiable evidence or workspace revision" };
  }
  return { passed: true, detail: criterion.id + " passed with evidence" };
}

export class AgentEvaluationRunner implements EvaluationRunner {
  constructor(private readonly runAgent: (request: AgentRequest) => Promise<AgentResult>) {}

  async run(testCase: EvaluationCase): Promise<EvaluationResult> {
    const started = Date.now();
    const fail = (details: string): EvaluationResult => ({
      caseId: testCase.id,
      passed: false,
      score: 0,
      durationMs: Date.now() - started,
      details,
    });

    if (!testCase.id.trim() || !testCase.task.trim()) return fail("Evaluation case requires a non-empty id and task.");
    if (testCase.acceptanceCriteria.length === 0) return fail("Evaluation case requires at least one acceptance criterion.");
    if (!testCase.probes || testCase.probes.length !== testCase.acceptanceCriteria.length) {
      return fail("Evaluation is unscorable: every acceptance criterion must have one explicit evidence-producing probe.");
    }
    if (testCase.probes.some((probe) => !probe.id.trim() || !probe.description.trim() || !probe.probe.tool.trim() || typeof probe.evaluate !== "function")) {
      return fail("Evaluation case contains an invalid acceptance probe.");
    }
    if (testCase.probes.some((probe, index) => probe.description.trim() !== testCase.acceptanceCriteria[index]?.trim())) {
      return fail("Each executable probe description must match its acceptance criterion.");
    }
    if (testCase.expected?.minSteps !== undefined && testCase.expected.minSteps < 0) {
      return fail("Evaluation minSteps must be non-negative.");
    }
    if (testCase.expected?.maxSteps !== undefined && testCase.expected.maxSteps < 0) {
      return fail("Evaluation maxSteps must be non-negative.");
    }
    if (
      testCase.expected?.minSteps !== undefined &&
      testCase.expected?.maxSteps !== undefined &&
      testCase.expected.minSteps > testCase.expected.maxSteps
    ) {
      return fail("Evaluation minSteps cannot exceed maxSteps.");
    }

    try {
      const result = await this.runAgent({
        task: testCase.task,
        useBrain: true,
        acceptanceCriteria: testCase.probes,
      });
      const report = result.brainReport;
      const completionPassed = report?.completed === true && report.state === "completed";
      const outcomes = testCase.probes.map((probe) => criterionOutcome(probe, report));
      const expectations = expectedChecks(testCase, result);
      const allChecks = [
        { label: "agent completed", passed: completionPassed },
        ...outcomes.map((outcome) => ({ label: outcome.detail, passed: outcome.passed })),
        ...expectations,
      ];
      const passedCount = allChecks.filter((check) => check.passed).length;
      const score = allChecks.length === 0 ? 0 : passedCount / allChecks.length;
      const passed = completionPassed && outcomes.every((outcome) => outcome.passed) && expectations.every((check) => check.passed);
      return {
        caseId: testCase.id,
        passed,
        score,
        durationMs: Date.now() - started,
        details: allChecks.map((check) => (check.passed ? "PASS: " : "FAIL: ") + check.label).join("; "),
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
}
