import assert from "node:assert/strict";
import test from "node:test";
import { parsePlan, parseUnderstanding } from "./planner.js";

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

test("parseUnderstanding normalizes a model singleton string into a one-item list", () => {
  const parsed = parseUnderstanding({ ...valid, ambiguities: "No ambiguity; answer directly." });
  assert.deepEqual(parsed.ambiguities, ["No ambiguity; answer directly."]);
  assert.deepEqual(parseUnderstanding({ ...valid, ambiguities: "" }).ambiguities, []);
});

test("parseUnderstanding still rejects non-string, non-array list values", () => {
  for (const ambiguities of [1, null, {}, true]) {
    assert.throws(
      () => parseUnderstanding({ ...valid, ambiguities }),
      /field "ambiguities".*expected string array/,
    );
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

test("parsePlan reports the invalid field and received type without echoing values", () => {
  assert.throws(
    () => parsePlan({ strategy: "invalid-secret-value", reason: "test", steps: [] }, 10),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /field "strategy"/);
      assert.match(error.message, /received type string/);
      assert.doesNotMatch(error.message, /invalid-secret-value/);
      return true;
    },
  );
  assert.throws(
    () => parsePlan({ strategy: "initial", reason: "test", steps: "secret" }, 10),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /field "steps"/);
      assert.match(error.message, /received type string/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});
