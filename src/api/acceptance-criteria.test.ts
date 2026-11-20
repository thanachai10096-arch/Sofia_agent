import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAcceptanceCriteria } from "./server.js";

test("acceptance probes pass only when the result explicitly sets passed to true", () => {
  const criteria = normalizeAcceptanceCriteria([{
    id: "verified",
    description: "A probe must return a strict boolean success value",
    probe: { tool: "test.probe", input: {} },
  }]);
  assert.equal(criteria?.length, 1);
  const evaluate = criteria![0]!.evaluate;

  assert.equal(evaluate({ passed: true }).passed, true);
  assert.equal(evaluate({ passed: false }).passed, false);
  assert.equal(evaluate({ passed: "true" }).passed, false);
  assert.equal(evaluate({ passed: 1 }).passed, false);
  assert.equal(evaluate({ passed: {} }).passed, false);
  assert.equal(evaluate({}).passed, false);
  assert.equal(evaluate(null).passed, false);
  assert.equal(evaluate("passed").passed, false);
});
