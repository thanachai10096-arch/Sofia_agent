import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionContext } from "./context.js";

test("session context uses recent turns and labels transcript as untrusted", () => {
  const context = buildSessionContext([
    "user: old topic",
    "assistant: old answer",
    ...Array.from({ length: 11 }, (_, index) => `user: intermediate ${index}`),
    "user: remember the blue bicycle",
  ]);
  assert.match(context ?? "", /Prior conversation/);
  assert.match(context ?? "", /UNTRUSTED_TOOL_OUTPUT/);
  assert.match(context ?? "", /blue bicycle/);
  assert.doesNotMatch(context ?? "", /old topic/);
});

test("session context respects the configured size bound", () => {
  const context = buildSessionContext(["x".repeat(1000), "y".repeat(1000)], undefined, 100);
  assert.ok((context?.length ?? 0) <= 612);
});

test("session context preserves explicit caller context", () => {
  const context = buildSessionContext([], "Workspace: project alpha");
  assert.equal(context, "Workspace: project alpha");
});

test("session context rejects invalid size limits", () => {
  assert.throws(() => buildSessionContext(["hello"], undefined, 0), /positive safe integer/);
});
