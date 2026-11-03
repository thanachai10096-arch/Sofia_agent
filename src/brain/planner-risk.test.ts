import assert from "node:assert/strict";
import test from "node:test";
import { parseUnderstanding } from "./planner.js";

const valid = {
  objective: "Say hello",
  constraints: [],
  assumptions: [],
  requiredCapabilities: [],
  requiredTools: [],
  risk: "low",
  successCriteria: ["Respond"],
  ambiguities: [],
};

test("parseUnderstanding accepts each supported risk value", () => {
  for (const risk of ["low", "medium", "high"] as const) {
    assert.equal(parseUnderstanding({ ...valid, risk }).risk, risk);
  }
});

test("parseUnderstanding rejects invalid risk with a safe field/type diagnostic", () => {
  for (const risk of ["critical", 1, null, [], {}]) {
    assert.throws(
      () => parseUnderstanding({ ...valid, risk }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /field "risk"/);
        assert.match(error.message, /received type/);
        assert.doesNotMatch(error.message, /critical/);
        return true;
      },
    );
  }
});
