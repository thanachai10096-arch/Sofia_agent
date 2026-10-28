import assert from "node:assert/strict";
import test from "node:test";
import { packWithSofiaGateway } from "./sofia-evidence-packing.mjs";

const task = {
  id: "regression-task",
  question: "What is the project code?",
  relevant: "Project code: SOFIA-731.",
  noise: "Unrelated note about a plant, schedule, and sample build.",
};

test("Sofia packer preserves the high-relevance answer evidence", async () => {
  const result = await packWithSofiaGateway(task);
  assert.ok(result.selectedEvidence.some((item) => item.text === task.relevant));
  assert.ok(result.packedText.includes("SOFIA-731"));
});

test("Sofia packer removes enough irrelevant evidence to reduce context", async () => {
  const result = await packWithSofiaGateway(task);
  assert.ok(result.selectedEvidence.length < result.suppliedEvidenceCount);
  assert.ok(result.inputTokensUpperBound > 0);
});

test("Sofia packer returns no duplicate evidence text", async () => {
  const result = await packWithSofiaGateway(task);
  assert.equal(new Set(result.selectedEvidence.map((item) => item.text)).size, result.selectedEvidence.length);
});

test("Sofia packer preserves answer evidence across different task IDs", async () => {
  const result = await packWithSofiaGateway({ ...task, id: "other-task" });
  assert.ok(result.selectedEvidence.some((item) => item.id === "other-task-relevant"));
});
