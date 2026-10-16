import assert from "node:assert/strict";
import test from "node:test";
import { parseNodeTestSummary } from "./test-summary.js";

test("parses a complete Node TAP summary into structured counts", () => {
  const result = parseNodeTestSummary([
    "TAP version 13",
    "1..3",
    "ok 1 - first",
    "ok 2 - second",
    "ok 3 - third",
    "# tests 3",
    "# pass 3",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 12.5",
  ].join("\n"));
  assert.deepEqual(result, {
    testsTotal: 3,
    passedTests: 3,
    failedTests: 0,
    skippedTests: 0,
    cancelledTests: 0,
    todoTests: 0,
  });
});

test("missing, contradictory, empty, or oversized TAP summaries remain unverified", () => {
  assert.equal(parseNodeTestSummary("TAP version 13\n# tests 3\n# pass 3"), undefined);
  assert.equal(parseNodeTestSummary("# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0"), undefined);
  assert.equal(parseNodeTestSummary("# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0"), undefined);
  assert.equal(parseNodeTestSummary("x".repeat(8_000_001)), undefined);
});

test("does not accept a passing-looking TAP summary with skipped or todo tests as complete", () => {
  const result = parseNodeTestSummary("# tests 3\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 1");
  assert.ok(result);
  assert.equal(result.testsTotal, 3);
  assert.equal(result.skippedTests, 1);
  assert.equal(result.todoTests, 1);
});
