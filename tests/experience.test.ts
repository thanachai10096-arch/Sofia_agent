import { test } from "node:test";
import assert from "node:assert/strict";
import { progressFromAgentEvent } from "../src/experience/progress.js";

test("maps technical events to plain-language progress", () => {
  const progress = progressFromAgentEvent({
    type: "tool.started",
    message: "Running workspace.write_file.",
    metadata: { tool: "workspace.write_file" },
  });
  assert.deepEqual(progress, {
    phase: "build",
    title: "Sofia is making the changes.",
  });
});

test("does not expose model details in simple progress", () => {
  const progress = progressFromAgentEvent({
    type: "model.selected",
    message: "Internal model route selected.",
  });
  assert.equal(progress?.title, "Sofia is choosing the best approach.");
  assert.equal(progress?.technical, undefined);
});
