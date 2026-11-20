import test from "node:test";
import assert from "node:assert/strict";
import { SofiaPluginHost } from "./plugin-host.js";
import type { SofiaTool } from "../../tools/types.js";

function tool(name: string): SofiaTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { ok: true }; },
  };
}

test("plugin host installs tools and services into one Sofia runtime", () => {
  const host = new SofiaPluginHost();
  host.use({
    id: "test.plugin",
    install(ctx) {
      ctx.registerTool(tool("test.read"));
      ctx.provideService("test.counter", { value: 7 });
    },
  });

  assert.deepEqual(host.listPlugins(), ["test.plugin"]);
  assert.equal(host.listTools()[0]?.name, "test.read");
  assert.equal(host.listTools().length, 1);
  assert.deepEqual(host.listTools()[0] && { name: host.listTools()[0].name }, { name: "test.read" });
});

test("plugin host rejects duplicate plugin and tool identities", () => {
  const host = new SofiaPluginHost();
  host.use({ id: "one", install: (ctx) => ctx.registerTool(tool("shared.tool")) });
  assert.throws(() => host.use({ id: "one", install() {} }), /already installed/);
  assert.throws(() => host.use({ id: "two", install: (ctx) => ctx.registerTool(tool("shared.tool")) }), /already registered/);
});

test("failed plugin installation rolls back registrations", () => {
  const host = new SofiaPluginHost();
  assert.throws(() => host.use({
    id: "broken",
    install(ctx) {
      ctx.registerTool(tool("temporary.tool"));
      throw new Error("installation failed");
    },
  }), /installation failed/);
  assert.deepEqual(host.listTools(), []);
  assert.deepEqual(host.listPlugins(), []);
});

test("disposing the host reverses plugin effects and is idempotent", () => {
  const host = new SofiaPluginHost();
  const disposed: string[] = [];
  host.use({ id: "first", install(ctx) { ctx.onDispose(() => disposed.push("first")); } });
  host.use({ id: "second", install(ctx) { ctx.onDispose(() => disposed.push("second")); } });
  host.dispose();
  host.dispose();
  assert.deepEqual(disposed, ["second", "first"]);
  assert.throws(() => host.listTools(), /disposed/);
});
