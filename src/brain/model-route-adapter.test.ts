import assert from "node:assert/strict";
import test from "node:test";
import { estimatePromptTokensUpperBound } from "./model-route-adapter.js";

test("route context estimate does not count UTF-8 bytes as tokens for Thai", () => {
  const value = { task: "สวัสดี" };
  const estimate = estimatePromptTokensUpperBound(value);
  const serialized = JSON.stringify(value);
  assert.equal(estimate, Array.from(serialized).length);
  assert.ok(estimate < new TextEncoder().encode(serialized).byteLength);
});

test("route context estimate remains bounded for long mixed-language prompts", () => {
  const value = { task: "ช่วยตรวจระบบ Sofia Agent " + "ภาษาไทย English ".repeat(500) };
  const estimate = estimatePromptTokensUpperBound(value);
  assert.ok(Number.isSafeInteger(estimate));
  assert.ok(estimate > 1_000);
  assert.ok(estimate < 20_000);
});
