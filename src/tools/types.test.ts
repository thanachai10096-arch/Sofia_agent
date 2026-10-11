import assert from "node:assert/strict";
import test from "node:test";
import { validateToolInput } from "./types.js";

const schema = {
  type: "object",
  properties: {
    command: { type: "string" },
    kind: { type: "string", enum: ["typecheck", "test", "build"] },
    args: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["command", "kind"],
  additionalProperties: false,
};

test("tool input validation accepts well-formed arguments", () => {
  assert.doesNotThrow(() => validateToolInput(schema, { command: "npm", kind: "test", args: ["run", "test"] }));
});

test("tool input validation rejects missing required fields and unexpected fields", () => {
  assert.throws(() => validateToolInput(schema, { command: "npm" }), /missing required property "kind"/);
  assert.throws(() => validateToolInput(schema, { command: "npm", kind: "test", shell: true }), /unexpected property "shell"/);
});

test("tool input validation rejects wrong types and enum values", () => {
  assert.throws(() => validateToolInput(schema, { command: 42, kind: "test" }), /expected string/);
  assert.throws(() => validateToolInput(schema, { command: "npm", kind: "deploy" }), /not an allowed enum member/);
});

test("tool input validation checks nested array items and bounds", () => {
  assert.throws(() => validateToolInput(schema, { command: "npm", kind: "test", args: ["run", 5] }), /expected string/);
  assert.throws(() => validateToolInput(schema, { command: "npm", kind: "test", args: [] }), /expected at least 1 items/);
});
