export interface NodeTestSummary {
  testsTotal: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  cancelledTests: number;
  todoTests: number;
}

/**
 * Parse only Node's TAP summary emitted by the repository test runner.
 * Missing, truncated, contradictory, or oversized output stays unverified.
 */
export function parseNodeTestSummary(output: unknown): NodeTestSummary | undefined {
  if (typeof output !== "string" || output.length > 8_000_000) return undefined;

  const readLast = (label: string): number | undefined => {
    const expression = new RegExp("^# " + label + " (\\d+)\\s*$", "gm");
    let value: number | undefined;
    for (const match of output.matchAll(expression)) {
      const parsed = Number(match[1]);
      if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
      value = parsed;
    }
    return value;
  };

  const testsTotal = readLast("tests");
  const passedTests = readLast("pass");
  const failedTests = readLast("fail");
  const skippedTests = readLast("skipped");
  const cancelledTests = readLast("cancelled");
  const todoTests = readLast("todo");
  if ([testsTotal, passedTests, failedTests, skippedTests, cancelledTests, todoTests].some((value) => value === undefined)) {
    return undefined;
  }
  const summary: NodeTestSummary = {
    testsTotal: testsTotal!,
    passedTests: passedTests!,
    failedTests: failedTests!,
    skippedTests: skippedTests!,
    cancelledTests: cancelledTests!,
    todoTests: todoTests!,
  };
  if (summary.testsTotal < 1) return undefined;
  if (summary.testsTotal !== summary.passedTests + summary.failedTests + summary.skippedTests + summary.cancelledTests + summary.todoTests) {
    return undefined;
  }
  return Object.freeze(summary);
}
