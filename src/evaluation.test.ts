import assert from "node:assert/strict";
import test from "node:test";
import { AgentEvaluationRunner, type EvaluationCase } from "./evaluation.js";
import type { AgentResult } from "./agent/types.js";
import type { AcceptanceCriterion, CompletionReport } from "./brain/types.js";

function criterion(id: string): AcceptanceCriterion {
  return {
    id,
    description: "Verify " + id,
    probe: { tool: "project.verify", input: { kind: "test" } },
    evaluate: (data) => {
      const passed = (data as { passed?: unknown })?.passed === true;
      return { passed, detail: passed ? "observable check passed" : "observable check failed" };
    },
  };
}

function agentResult(
  probes: AcceptanceCriterion[],
  options: { completed?: boolean; verifiedIds?: string[]; output?: string } = {},
): AgentResult {
  const verifiedIds = options.verifiedIds ?? probes.map((item) => item.id);
  const report: CompletionReport = {
    completed: options.completed ?? true,
    state: options.completed === false ? "failed" : "completed",
    summary: "Finished",
    changedFiles: ["src/example.ts"],
    changedFilesKnown: true,
    verification: probes
      .filter((item) => verifiedIds.includes(item.id))
      .map((item) => ({
        criterionId: item.id,
        passed: true,
        detail: "passed",
        evidenceIds: ["evidence-" + item.id],
        workspaceRevision: "revision-1",
      })),
    remainingRisks: [],
    usage: { steps: 1, toolCalls: 1, modelCalls: 1, reservedOrUsedTokens: 10, replans: 0 },
  };
  return {
    runId: "eval-run",
    output: options.output ?? "expected result",
    kind: "research",
    steps: 1,
    events: [],
    brainReport: report,
  } as unknown as AgentResult;
}

function evaluationCase(probes?: AcceptanceCriterion[]): EvaluationCase {
  return {
    id: "case-1",
    task: "Perform a verifiable task",
    acceptanceCriteria: ["Criterion one"],
    ...(probes ? { probes } : {}),
  };
}

test("AgentEvaluationRunner refuses to score natural-language criteria without explicit probes", async () => {
  let calls = 0;
  const runner = new AgentEvaluationRunner(async () => {
    calls += 1;
    return agentResult([]);
  });
  const result = await runner.run(evaluationCase());
  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
  assert.match(result.details, /one explicit evidence-producing probe/);
  assert.equal(calls, 0);
});

test("AgentEvaluationRunner passes only when completion, probe evidence, and deterministic expectations pass", async () => {
  const probes = [criterion("criterion-1")];
  const runner = new AgentEvaluationRunner(async (request) => {
    assert.equal(request.useBrain, true);
    assert.deepEqual(request.acceptanceCriteria, probes);
    return agentResult(probes);
  });
  const result = await runner.run({
    ...evaluationCase(probes),
    expected: { outputIncludes: ["expected"], changedFilesInclude: ["src/example.ts"], minSteps: 1, maxSteps: 2 },
  });
  assert.equal(result.passed, true);
  assert.equal(result.score, 1);
  assert.match(result.details, /PASS: agent completed/);
});

test("AgentEvaluationRunner fails closed when a probe result is missing", async () => {
  const probes = [criterion("criterion-1")];
  const runner = new AgentEvaluationRunner(async () => agentResult(probes, { verifiedIds: [] }));
  const result = await runner.run(evaluationCase(probes));
  assert.equal(result.passed, false);
  assert.ok(result.score < 1);
  assert.match(result.details, /missing verification result/);
});

test("AgentEvaluationRunner does not mark a failed brain report as passed even if a probe appears green", async () => {
  const probes = [criterion("criterion-1")];
  const runner = new AgentEvaluationRunner(async () => agentResult(probes, { completed: false }));
  const result = await runner.run(evaluationCase(probes));
  assert.equal(result.passed, false);
  assert.match(result.details, /FAIL: agent completed/);
});

test("AgentEvaluationRunner fails when deterministic expected output does not match", async () => {
  const probes = [criterion("criterion-1")];
  const runner = new AgentEvaluationRunner(async () => agentResult(probes));
  const result = await runner.run({ ...evaluationCase(probes), expected: { outputEquals: "a different output" } });
  assert.equal(result.passed, false);
  assert.match(result.details, /output equals expected value/);
});

test("AgentEvaluationRunner converts agent errors into failed evaluation results", async () => {
  const probes = [criterion("criterion-1")];
  const runner = new AgentEvaluationRunner(async () => { throw new Error("provider unavailable"); });
  const result = await runner.run(evaluationCase(probes));
  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
  assert.equal(result.details, "provider unavailable");
});

test("AgentEvaluationRunner rejects contradictory step expectations before spending tokens", async () => {
  let calls = 0;
  const probes = [criterion("criterion-1")];
  const runner = new AgentEvaluationRunner(async () => {
    calls += 1;
    return agentResult(probes);
  });
  const result = await runner.run({ ...evaluationCase(probes), expected: { minSteps: 5, maxSteps: 2 } });
  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
  assert.equal(calls, 0);
});
