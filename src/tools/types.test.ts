import assert from "node:assert/strict";
import test from "node:test";
import { MapToolRegistry, validateToolInput, type SofiaTool } from "./types.js";

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

function makeTool(overrides: Partial<SofiaTool> = {}): SofiaTool {
  return {
    name: "workspace.read_file",
    description: "Read a workspace file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    effects: ["read"],
    async execute(input) { return input.path; },
    ...overrides,
  };
}

test("registry snapshots tool metadata and nested input schema at registration", () => {
  const original = makeTool();
  const registry = new MapToolRegistry([original]);
  original.name = "workspace.write_file";
  original.effects = ["write"];
  (original.inputSchema.properties as Record<string, unknown>).path = { type: "number" };

  const registered = registry.get("workspace.read_file");
  assert.ok(registered);
  assert.equal(registered.name, "workspace.read_file");
  assert.deepEqual(registered.effects, ["read"]);
  assert.doesNotThrow(() => validateToolInput(registered.inputSchema, { path: "README.md" }));
  assert.equal(registry.get("workspace.write_file"), undefined);
});

test("registry callers cannot mutate registered descriptors or nested schemas", () => {
  const registry = new MapToolRegistry([makeTool()]);
  const listed = registry.list();
  assert.throws(() => { listed[0]!.name = "browser.goto"; }, TypeError);
  assert.throws(() => {
    (listed[0]!.inputSchema.properties as Record<string, unknown>).path = { type: "number" };
  }, TypeError);
  assert.throws(() => { (listed[0]!.effects as string[]).push("destructive"); }, TypeError);
  assert.equal(registry.get("workspace.read_file")?.name, "workspace.read_file");
  assert.deepEqual(registry.get("workspace.read_file")?.effects, ["read"]);
});

test("registry rejects duplicate tool names instead of selecting an ambiguous handler", () => {
  assert.throws(() => new MapToolRegistry([makeTool(), makeTool()]), /Duplicate tool name/);
});

test("registry rejects malformed descriptors and undeclared security effects", () => {
  assert.throws(() => new MapToolRegistry([makeTool({ name: "../unsafe" })]), /valid non-empty identifier/);
  assert.throws(() => new MapToolRegistry([makeTool({ description: " " })]), /must have a description/);
  assert.throws(() => new MapToolRegistry([makeTool({ effects: ["unknown" as never] })]), /unsupported security effect/);
});
