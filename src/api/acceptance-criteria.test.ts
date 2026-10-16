import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAcceptanceCriteria } from "./server.js";

test("API acceptance probes only pass on an explicit boolean true", () => {
  const normalized = normalizeAcceptanceCriteria([{
    id: "check",
    description: "Probe evidence must be boolean",
    probe: { tool: "verification", input: {} },
  }]);
  assert.ok(normalized);
  const evaluate = normalized[0]!.evaluate;

  assert.equal(evaluate({ passed: true }).passed, true);
  assert.equal(evaluate({ passed: false }).passed, false);
  assert.equal(evaluate({ passed: "false" }).passed, false);
  assert.equal(evaluate({ passed: "true" }).passed, false);
  assert.equal(evaluate({ passed: 1 }).passed, false);
  assert.equal(evaluate({}).passed, false);
  assert.equal(evaluate(null).passed, false);
});
