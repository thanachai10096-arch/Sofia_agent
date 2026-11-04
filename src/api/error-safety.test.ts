import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorMessage } from "./error-safety.js";

test("safeErrorMessage redacts known credentials and bounds provider errors", () => {
  const message = safeErrorMessage(
    new Error("provider rejected request: api_key=sk-1234567890abcdefghijklmnop Bearer abcdefghijklmnopqrstuvwxyz123456"),
    "Agent failed",
  );
  assert.doesNotMatch(message, /sk-1234567890abcdefghijklmnop/);
  assert.doesNotMatch(message, /Bearer abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(message, /REDACTED/);
  assert.ok(message.length <= 500);
});

test("safeErrorMessage normalizes multiline errors and uses a fallback for unknown values", () => {
  assert.equal(safeErrorMessage(new Error("line one\nline two\tline three"), "fallback"), "line one line two line three");
  assert.equal(safeErrorMessage(null, "Agent failed"), "Agent failed");
  assert.equal(safeErrorMessage(new Error("   "), "Agent failed"), "Agent failed");
});
