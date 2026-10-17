import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BatchEvaluationRunner } from "../src/evaluation/batch.js";
import { TrajectoryRecorder } from "../src/evaluation/trajectory.js";
import type { EvaluationCase, EvaluationResult, EvaluationRunner } from "../src/evaluation.js";

function makeCase(id: string): EvaluationCase { return { id, task: "fixture task", acceptanceCriteria: ["criterion"] }; }
class FakeRunner implements EvaluationRunner {
  async run(testCase: EvaluationCase): Promise<EvaluationResult> {
    return { caseId: testCase.id, passed: testCase.id !== "fail", score: testCase.id === "fail" ? 0 : 1, durationMs: 1, details: "result" };
  }
}
function tempDir(): string { return mkdtempSync(path.join(os.tmpdir(), "sofia-eval-")); }

test("batch evaluation preserves input order and aggregates results", async () => {
  const runner = new BatchEvaluationRunner(new FakeRunner());
  const report = await runner.run([makeCase("a"), makeCase("fail"), makeCase("c")], { concurrency: 2 });
  assert.deepEqual(report.results.map((item) => item.caseId), ["a", "fail", "c"]);
  assert.equal(report.total, 3);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.passRate, 2 / 3);
});

test("batch evaluation rejects duplicate ids and excessive concurrency", async () => {
  const runner = new BatchEvaluationRunner(new FakeRunner());
  await assert.rejects(runner.run([makeCase("a"), makeCase("a")]), /Duplicate evaluation case id/);
  await assert.rejects(runner.run([makeCase("a")], { concurrency: 99 }), /concurrency/);
});

test("trajectory recorder redacts secret fields and appends bounded JSONL", () => {
  const directory = tempDir();
  try {
    const file = path.join(directory, "nested", "trajectory.jsonl");
    const recorder = new TrajectoryRecorder({ file });
    recorder.record("case", { caseId: "demo", api_key: "secret-value", details: "Bearer abc.def.ghi" });
    const event = JSON.parse(readFileSync(file, "utf8").trim()) as { sequence: number; data: Record<string, unknown> };
    assert.equal(event.sequence, 1);
    assert.equal(event.data.api_key, "[REDACTED]");
    assert.match(String(event.data.details), /Bearer \[REDACTED\]/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("trajectory recorder rejects relative paths and oversized events", () => {
  assert.throws(() => new TrajectoryRecorder({ file: "relative.jsonl" }), /absolute/);
  const directory = tempDir();
  try {
    const recorder = new TrajectoryRecorder({ file: path.join(directory, "trajectory.jsonl"), maxEventBytes: 1024, maxStringLength: 100_000 });
    assert.throws(() => recorder.record("large", { content: "x".repeat(2_000) }), /exceeds/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
