import assert from "node:assert/strict";
import test from "node:test";
import { isCliEntrypoint, resolveCliInvocation } from "./commands.js";

test("CLI entrypoint is recognized when argv points to this module", () => {
  assert.equal(
    isCliEntrypoint("/workspace/src/cli/index.js", "file:///workspace/src/cli/index.js"),
    true,
  );
});

test("importing the CLI module is not treated as process entrypoint", () => {
  assert.equal(
    isCliEntrypoint("/workspace/src/api/entrypoint.js", "file:///workspace/src/cli/index.js"),
    false,
  );
  assert.equal(isCliEntrypoint(undefined, "file:///workspace/src/cli/index.js"), false);
});

test("CLI command parsing remains side-effect free", () => {
  assert.deepEqual(resolveCliInvocation(["run", "inspect", "workspace"]), {
    command: "run",
    task: "inspect workspace",
  });
  assert.deepEqual(resolveCliInvocation(["chat"]), { command: "chat" });
});

test("importing CLI entrypoint exposes main without running commands", async () => {
  const cli = await import("./index.js");
  assert.equal(typeof cli.main, "function");
});
