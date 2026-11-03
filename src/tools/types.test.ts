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


test("tool input validation enforces string and numeric bounds", () => {
  assert.throws(
    () => validateToolInput({ type: "object", properties: { name: { type: "string", minLength: 2, maxLength: 4 } }, required: ["name"] }, { name: "x" }),
    /at least 2 characters/,
  );
  assert.throws(
    () => validateToolInput({ type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 5 } }, required: ["count"] }, { count: 6 }),
    /above maximum 5/,
  );
  assert.throws(
    () => validateToolInput({ type: "object", properties: { ratio: { type: "number", exclusiveMinimum: 0 } }, required: ["ratio"] }, { ratio: 0 }),
    /must be greater than 0/,
  );
});

test("tool input validation enforces unique array items and object property bounds", () => {
  assert.throws(
    () => validateToolInput({ type: "object", properties: { tags: { type: "array", uniqueItems: true, items: { type: "string" } } } }, { tags: ["same", "same"] }),
    /expected unique items/,
  );
  assert.throws(
    () => validateToolInput({ type: "object", minProperties: 1 }, {}),
    /expected at least 1 properties/,
  );
  assert.throws(
    () => validateToolInput({ type: "object", maxProperties: 1 }, { a: 1, b: 2 }),
    /expected at most 1 properties/,
  );
});
