import assert from "node:assert/strict";
import test from "node:test";
import { createCliSessionId } from "./session-id.js";

test("interactive CLI chat reuses its stable transcript identifier", () => {
  assert.equal(createCliSessionId(true, "ignored"), "cli:default");
  assert.equal(createCliSessionId(true), "cli:default");
});

test("one-shot CLI runs receive distinct transcript identifiers", () => {
  const first = createCliSessionId(false);
  const second = createCliSessionId(false);
  assert.match(first, /^cli:run:[0-9a-f-]{36}$/i);
  assert.match(second, /^cli:run:[0-9a-f-]{36}$/i);
  assert.notEqual(first, second);
});

test("one-shot CLI session identifiers can be deterministic in tests", () => {
  assert.equal(createCliSessionId(false, "run-123"), "cli:run:run-123");
});
