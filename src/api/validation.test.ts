import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentRunInput } from "./validation.js";

test("API run validation accepts a minimal valid task", () => {
  assert.deepEqual(validateAgentRunInput({ task: "  inspect repository  " }), {
    valid: true,
    input: { task: "  inspect repository  " },
  });
});

test("API run validation rejects non-object bodies and missing tasks", () => {
  assert.equal(validateAgentRunInput(null).valid, false);
  assert.equal(validateAgentRunInput([]).valid, false);
  assert.deepEqual(validateAgentRunInput({ task: " " }), { valid: false, error: "task_required" });
});

test("API run validation enforces execution bounds and primitive types", () => {
  assert.equal(validateAgentRunInput({ task: "run", maxSteps: 0 }).valid, false);
  assert.equal(validateAgentRunInput({ task: "run", maxSteps: 201 }).valid, false);
  assert.equal(validateAgentRunInput({ task: "run", maxSteps: 10, async: "yes" }).valid, false);
  assert.equal(validateAgentRunInput({ task: "run", priority: "urgent" }).valid, false);
});

test("API run validation rejects malformed acceptance criteria", () => {
  assert.equal(validateAgentRunInput({ task: "run", acceptanceCriteria: [{}] }).valid, false);
  assert.equal(validateAgentRunInput({ task: "run", acceptanceCriteria: new Array(51).fill({}) }).valid, false);
  assert.equal(validateAgentRunInput({
    task: "run",
    acceptanceCriteria: [{
      id: "build",
      description: "Build succeeds",
      probe: { tool: "shell", input: { command: "npm run build" } },
    }],
  }).valid, true);
});
test("API run validation rejects duplicate acceptance criterion IDs", () => {
  const criterion = {
    id: "build",
    description: "Build succeeds",
    probe: { tool: "verification", input: {} },
  };
  assert.equal(validateAgentRunInput({
    task: "run",
    acceptanceCriteria: [criterion, { ...criterion, description: "Second criterion" }],
  }).valid, false);
});


test("API run validation accepts supported model profiles and rejects unknown profiles", () => {
  for (const modelSelection of ["auto", "fast", "coding", "reasoning", "vision"]) {
    assert.equal(validateAgentRunInput({ task: "run", modelSelection }).valid, true);
  }
  assert.deepEqual(validateAgentRunInput({ task: "run", modelSelection: "arbitrary-provider-model" }), {
    valid: false,
    error: "invalid_model_selection",
  });
});
