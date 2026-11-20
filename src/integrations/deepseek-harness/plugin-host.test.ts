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

test("plugin host installs tools and exposes registered services", () => {
  const host = new SofiaPluginHost();
  const counter = { value: 7 };
  host.use({
    id: "test.plugin",
    install(ctx) {
      ctx.registerTool(tool("test.read"));
      ctx.provideService("test.counter", counter);
      assert.equal(ctx.getService<typeof counter>("test.counter"), counter);
    },
  });

  assert.deepEqual(host.listPlugins(), ["test.plugin"]);
  assert.equal(host.listTools()[0]?.name, "test.read");
  assert.equal(host.listTools().length, 1);
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
      ctx.provideService("temporary.service", true);
      throw new Error("installation failed");
    },
  }), /installation failed/);
  assert.deepEqual(host.listTools(), []);
  assert.deepEqual(host.listPlugins(), []);
  host.use({ id: "recovered", install: (ctx) => ctx.registerTool(tool("temporary.tool")) });
  assert.deepEqual(host.listPlugins(), ["recovered"]);
});

test("lifecycle events fire on install and unload", () => {
  const host = new SofiaPluginHost();
  const events: string[] = [];
  host.on("plugin:installed", ({ pluginId }) => events.push(`installed:${pluginId}`));
  const stop = host.on("plugin:uninstalled", ({ pluginId }) => events.push(`uninstalled:${pluginId}`));
  host.use({ id: "events.plugin", install() {} });
  assert.equal(host.unuse("events.plugin"), true);
  assert.equal(host.unuse("events.plugin"), false);
  stop();
  assert.deepEqual(events, ["installed:events.plugin", "uninstalled:events.plugin"]);
});

test("disposing runs every cleanup in reverse plugin order and is idempotent", () => {
  const host = new SofiaPluginHost();
  const disposed: string[] = [];
  host.use({ id: "first", install(ctx) { ctx.onDispose(() => disposed.push("first")); } });
  host.use({ id: "second", install(ctx) { ctx.onDispose(() => disposed.push("second")); } });
  host.dispose();
  host.dispose();
  assert.deepEqual(disposed, ["second", "first"]);
  assert.throws(() => host.listTools(), /disposed/);
});

test("a failing cleanup does not prevent other plugins from being disposed", () => {
  const host = new SofiaPluginHost();
  const disposed: string[] = [];
  host.use({ id: "first", install(ctx) { ctx.onDispose(() => disposed.push("first")); } });
  host.use({ id: "second", install(ctx) {
    ctx.onDispose(() => disposed.push("second"));
    ctx.onDispose(() => { throw new Error("cleanup failed"); });
  } });
  assert.throws(() => host.dispose(), /failed to dispose/);
  assert.deepEqual(disposed, ["second", "first"]);
  assert.throws(() => host.listTools(), /disposed/);
});

test("host cannot be repopulated from a disposal callback", () => {
  const host = new SofiaPluginHost();
  host.use({
    id: "reentrant",
    install(ctx) {
      ctx.onDispose(() => {
        assert.throws(() => host.use({ id: "late", install() {} }), /disposed/);
      });
    },
  });
  host.dispose();
  assert.throws(() => host.listPlugins(), /disposed/);
});

test("plugin manifests require dependencies to be installed first", () => {
  const host = new SofiaPluginHost();
  assert.throws(() => host.use({
    id: "consumer",
    manifest: { version: "1.0.0", capabilities: [], dependencies: ["provider"] },
    install() {},
  }), /requires plugin "provider"/);
  host.use({ id: "provider", manifest: { version: "1.0.0", capabilities: [] }, install() {} });
  host.use({
    id: "consumer",
    manifest: { version: "1.0.0", capabilities: [], dependencies: ["provider"] },
    install() {},
  });
  assert.throws(() => host.unuse("provider"), /while "consumer" depends on it/);
  assert.equal(host.unuse("consumer"), true);
  assert.equal(host.unuse("provider"), true);
});

test("plugin manifest rejects tools whose declared effects exceed capabilities", () => {
  const host = new SofiaPluginHost();
  assert.throws(() => host.use({
    id: "limited",
    manifest: { version: "1.0.0", capabilities: ["read"] },
    install(ctx) {
      ctx.registerTool({ ...tool("network.read"), effects: ["read", "network"] });
    },
  }), /does not declare effective tool capability "network"/);
  assert.deepEqual(host.listPlugins(), []);
  assert.deepEqual(host.listTools(), []);
});

test("plugin manifests are exposed as defensive metadata copies", () => {
  const host = new SofiaPluginHost();
  host.use({
    id: "reader",
    manifest: { version: "1.2.0", description: "Read-only connector", capabilities: ["read", "network"] },
    install() {},
  });
  const manifest = host.getPluginManifest("reader");
  assert.deepEqual(manifest?.capabilities, ["read", "network"]);
  assert.equal(manifest?.version, "1.2.0");
  assert.equal(host.getPluginManifest("missing"), undefined);
});

test("plugin services are visible only to the provider and declared dependents", () => {
  const host = new SofiaPluginHost();
  host.use({
    id: "service.provider",
    manifest: { version: "1.0.0", capabilities: [] },
    install(ctx) { ctx.provideService("private.counter", { value: 3 }); },
  });
  host.use({
    id: "unrelated",
    manifest: { version: "1.0.0", capabilities: [] },
    install(ctx) { assert.throws(() => ctx.getService("private.counter"), /must declare "service.provider" as a dependency/); },
  });
  host.use({
    id: "consumer",
    manifest: { version: "1.0.0", capabilities: [], dependencies: ["service.provider"] },
    install(ctx) { assert.deepEqual(ctx.getService("private.counter"), { value: 3 }); },
  });
});

test("registered tool effects cannot be mutated after manifest validation", () => {
  const host = new SofiaPluginHost();
  const effects: ("read" | "network")[] = ["read"];
  host.use({
    id: "immutable.tool",
    manifest: { version: "1.0.0", capabilities: ["read"] },
    install(ctx) { ctx.registerTool({ ...tool("immutable.read"), effects }); },
  });
  effects.push("network");
  const registered = host.listTools()[0]!;
  assert.deepEqual(registered.effects, ["read"]);
  assert.equal(Object.isFrozen(registered), true);
  assert.equal(Object.isFrozen(registered.effects), true);
});

test("plugin manifests validate inferred effects even when a tool omits effects", () => {
  const host = new SofiaPluginHost();
  assert.throws(() => host.use({
    id: "concealed.browser",
    manifest: { version: "1.0.0", capabilities: ["read"] },
    install(ctx) { ctx.registerTool(tool("browser.click")); },
  }), /does not declare effective tool capability "browser"/);
  assert.deepEqual(host.listPlugins(), []);
  assert.deepEqual(host.listTools(), []);
});

test("undeclared custom tools require the destructive capability by default", () => {
  const host = new SofiaPluginHost();
  assert.throws(() => host.use({
    id: "unknown.tool",
    manifest: { version: "1.0.0", capabilities: ["read"] },
    install(ctx) { ctx.registerTool(tool("custom.unknown")); },
  }), /does not declare effective tool capability "destructive"/);
  host.use({
    id: "explicitly.risky",
    manifest: { version: "1.0.0", capabilities: ["destructive"] },
    install(ctx) { ctx.registerTool(tool("custom.unknown")); },
  });
  assert.equal(host.listTools().length, 1);
});


test("plugin hosts expose an immutable process, run, or principal ownership boundary", () => {
  const processHost = new SofiaPluginHost();
  assert.equal(processHost.scope, "process");
  assert.equal(processHost.principalId, undefined);

  const runHost = new SofiaPluginHost({ scope: "run" });
  assert.equal(runHost.scope, "run");

  const principalHost = new SofiaPluginHost({ scope: "principal", principalId: "user-123" });
  let observed: { scope: string; principalId?: string } | undefined;
  principalHost.use({
    id: "principal.connector",
    install(ctx) { observed = { scope: ctx.scope, principalId: ctx.principalId }; },
  });
  assert.deepEqual(observed, { scope: "principal", principalId: "user-123" });
  assert.throws(() => new SofiaPluginHost({ scope: "principal" }), /requires an authenticated principalId/);
  assert.throws(() => new SofiaPluginHost({ scope: "run", principalId: "user-123" }), /only be set on a principal-scoped/);
});
