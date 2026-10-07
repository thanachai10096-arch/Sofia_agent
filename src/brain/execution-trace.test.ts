import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionTrace } from "./execution-trace.js";

test("execution trace keeps ordered bounded entries", () => {
  const trace = new ExecutionTrace({ maxEntries: 2 });
  trace.append({ type: "brain.started", runId: "r1" });
  trace.append({ type: "brain.state.changed", runId: "r1", state: "understanding" });
  trace.append({ type: "brain.plan.created", runId: "r1" });

  const entries = trace.snapshot();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.sequence), [2, 3]);
  assert.ok(entries[0]?.timestamp);
  assert.equal(trace.size, 2);
});
