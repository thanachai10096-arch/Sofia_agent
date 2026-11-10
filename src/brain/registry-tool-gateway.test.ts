import assert from "node:assert/strict";
import test from "node:test";
import { RegistryToolGateway } from "./registry-tool-gateway.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import { createToolRegistry } from "../tools/registry.js";
import { createBuiltinTools } from "../tools/builtin.js";
import { defaultPolicy } from "../security/policy.js";
import { SecurityController } from "../security/controller.js";
import type { SecurityAuditEvent, SecurityAuditSink } from "../security/audit.js";
import { MapToolRegistry } from "../tools/types.js";

function runtime(): WorkspaceRuntime {
  const files = new Map<string, string>([["src/app.ts", "const x = 1;"]]);
  return {
    platform: "linux",
    async cwd() { return "/workspace"; },
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async writeFile(path, content) { files.set(path, content); },
    async listFiles() { return [...files.keys()]; },
    async search(query) {
      return [...files.entries()]
        .flatMap(([path, content]) =>
          content.includes(query) ? [path + ":1:" + content] : []);
    },
    async run() { return { stdout: "", stderr: "", code: 0 }; },
    async git(args) {
      if (args[0] === "status") {
        return { stdout: " M src/app.ts\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

test("snapshot detects content changes even when the path stays modified", async () => {
  const rt = runtime();
  const gateway = new RegistryToolGateway(
    { runtime: rt, tools: createToolRegistry(createBuiltinTools()) },
    defaultPolicy,
  );

  const baseline = await gateway.snapshot(new AbortController().signal);
  await rt.writeFile("src/app.ts", "const x = 2;");
  const changed = await gateway.changedFiles(
    baseline.id,
    new AbortController().signal,
  );

  assert.deepEqual(changed, ["src/app.ts"]);
});

test("workspace readiness discovery does not touch the workspace when tool policy blocks access", async () => {
  let cwdCalls = 0;
  let listFilesCalls = 0;
  const rt = {
    ...runtime(),
    async cwd() { cwdCalls += 1; return "/workspace"; },
    async listFiles() { listFilesCalls += 1; return ["src/app.ts"]; },
  } satisfies WorkspaceRuntime;
  const gateway = new RegistryToolGateway(
    { runtime: rt, tools: createToolRegistry(createBuiltinTools()) },
    { ...defaultPolicy, allowTools: false },
  );

  const discovered = await gateway.probeReadiness();
  const workspaceTools = discovered.filter((tool) => tool.name.startsWith("workspace."));

  assert.ok(workspaceTools.length > 0);
  assert.ok(workspaceTools.every((tool) => tool.policy?.status === "blocked"));
  assert.ok(workspaceTools.every((tool) => tool.runtimeReadiness === "not_probed"));
  assert.ok(workspaceTools.every((tool) => /probe skipped/i.test(tool.runtimeReason ?? "")));
  assert.equal(cwdCalls, 0, "blocked workspace discovery must not inspect the working directory");
  assert.equal(listFilesCalls, 0, "blocked workspace discovery must not list files");
});

test("inspection tools are available without write approval", async () => {
  const rt = runtime();
  const gateway = new RegistryToolGateway(
    { runtime: rt, tools: createToolRegistry(createBuiltinTools()) },
    defaultPolicy,
  );

  const result = await gateway.execute(
    { tool: "workspace.search", input: { query: "const x" } },
    {
      runId: "test",
      signal: new AbortController().signal,
      requireApproval: false,
      notifyApproval() {},
    },
  );

  assert.equal(result.ok, true);
});


test("web search remains disabled by default and runs only with network policy plus the fixed host allowlist", async () => {
  let executions = 0;
  const registry = new MapToolRegistry([{
    name: "web.search",
    description: "Fixed-endpoint search test double",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    effects: ["network", "read"] as const,
    async execute(input) {
      executions += 1;
      return { query: input.query, sources: [] };
    },
  }]);
  const context = {
    runId: "web-search-policy-test",
    principalId: "test-user",
    signal: new AbortController().signal,
    requireApproval: false,
    notifyApproval() {},
  };
  const disabled = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowNetwork: false, allowedHosts: ["api.search.brave.com"] },
  );
  const denied = await disabled.execute({ tool: "web.search", input: { query: "latest news" } }, context);
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.category, "permission_error");
  assert.equal(executions, 0);

  const wrongHost = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowNetwork: true, allowedHosts: ["example.com"] },
  );
  const hostDenied = await wrongHost.execute({ tool: "web.search", input: { query: "latest news" } }, context);
  assert.equal(hostDenied.ok, false);
  assert.match(hostDenied.error?.message ?? "", /allowlisted/i);
  assert.equal(executions, 0);

  const enabled = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowNetwork: true, allowedHosts: ["api.search.brave.com"] },
  );
  const allowed = await enabled.execute({ tool: "web.search", input: { query: "latest news" } }, context);
  assert.equal(allowed.ok, true);
  assert.equal(executions, 1);
});


test("HTTP MCP tools validate both fixed endpoint and model-supplied URLs", async () => {
  let executions = 0;
  const registry = new MapToolRegistry([{
    name: "mcp.docs.lookup",
    description: "Fixed endpoint MCP lookup",
    inputSchema: { type: "object", properties: { query: { type: "string" }, url: { type: "string" } }, required: ["query"], additionalProperties: false },
    effects: ["network", "read"] as const,
    networkUrl: "https://mcp.example.com/mcp",
    async execute() { executions += 1; return { ok: true }; },
  }]);
  const context = {
    runId: "mcp-fixed-endpoint-test",
    signal: new AbortController().signal,
    requireApproval: false,
    notifyApproval() {},
  };
  const blocked = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowNetwork: true, allowedHosts: ["attacker.example"] },
  );
  const denied = await blocked.execute({ tool: "mcp.docs.lookup", input: { query: "hello", url: "https://attacker.example" } }, context);
  assert.equal(denied.ok, false);
  assert.match(denied.error?.message ?? "", /allowlisted/i);
  assert.equal(executions, 0);

  const allowed = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowNetwork: true, allowedHosts: ["mcp.example.com"] },
    async () => true,
  );
  const modelUrlDenied = await allowed.execute({ tool: "mcp.docs.lookup", input: { query: "hello", url: "https://attacker.example" } }, context);
  assert.equal(modelUrlDenied.ok, false);
  assert.match(modelUrlDenied.error?.message ?? "", /allowlisted/i);
  assert.equal(executions, 0);

  const result = await allowed.execute({ tool: "mcp.docs.lookup", input: { query: "hello" } }, context);
  assert.equal(result.ok, true);
  assert.equal(executions, 1);
});

test("security kill switch aborts an active tool execution", async () => {
  const rt = runtime();
  const security = new SecurityController();
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let sawAbort = false;

  const registry = new MapToolRegistry([{
    name: "workspace.search",
    description: "Wait for cancellation in a controlled test",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    async execute(_input, context) {
      announceStarted();
      return await new Promise((_resolve, reject) => {
        const signal = context.signal;
        if (!signal) {
          reject(new Error("Expected a bound execution signal"));
          return;
        }
        const onAbort = () => {
          sawAbort = true;
          reject(signal.reason ?? new Error("aborted"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  }]);

  const gateway = new RegistryToolGateway(
    { runtime: rt, tools: registry },
    defaultPolicy,
    undefined,
    undefined,
    security,
  );
  const execution = gateway.execute(
    { tool: "workspace.search", input: { query: "wait" } },
    {
      runId: "kill-switch-test",
      signal: new AbortController().signal,
      requireApproval: false,
      notifyApproval() {},
    },
  );

  await started;
  security.kill("test requested emergency stop");
  const result = await execution;

  assert.equal(result.ok, false);
  assert.equal(sawAbort, true);
  assert.match(result.error?.message ?? "", /kill switch/i);
  assert.equal(security.status().killed, true);
});


test("security kill switch prevents a tool from starting after approval wait", async () => {
  const rt = runtime();
  const security = new SecurityController();
  let signalApprovalReached!: () => void;
  const approvalReached = new Promise<void>((resolve) => { signalApprovalReached = resolve; });
  let releaseApproval!: (approved: boolean) => void;
  const approvalDecision = new Promise<boolean>((resolve) => { releaseApproval = resolve; });
  let toolStarted = false;

  const registry = new MapToolRegistry([{
    name: "workspace.write_file",
    description: "Controlled write tool for approval cancellation test",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    async execute() {
      toolStarted = true;
      return { written: true };
    },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: rt, tools: registry },
    defaultPolicy,
    async () => {
      signalApprovalReached();
      return approvalDecision;
    },
    undefined,
    security,
  );

  const execution = gateway.execute(
    { tool: "workspace.write_file", input: { path: "src/approved-later.txt", content: "safe" } },
    {
      runId: "kill-switch-approval-test",
      signal: new AbortController().signal,
      requireApproval: true,
      notifyApproval() {},
    },
  );

  await approvalReached;
  security.kill("emergency stop during approval");
  releaseApproval(true);
  const result = await execution;

  assert.equal(result.ok, false);
  assert.equal(toolStarted, false);
  assert.match(result.error?.message ?? "", /kill switch/i);
});

test("approval cannot mutate the action that the gateway executes", async () => {
  const rt = runtime();
  let executedInput: Record<string, unknown> | undefined;
  const registry = new MapToolRegistry([{
    name: "workspace.write_file",
    description: "Capture approved input",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    async execute(input) {
      executedInput = input as Record<string, unknown>;
      return { written: true };
    },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: rt, tools: registry },
    defaultPolicy,
    async (request) => {
      request.input.path = "src/attacker-controlled.txt";
      request.input.content = "changed after approval";
      return true;
    },
  );

  const result = await gateway.execute(
    { tool: "workspace.write_file", input: { path: "src/approved.txt", content: "approved content" } },
    {
      runId: "approval-input-binding-test",
      signal: new AbortController().signal,
      requireApproval: true,
      notifyApproval() {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(executedInput?.path, "src/approved.txt");
  assert.equal(executedInput?.content, "approved content");
});

test("tool catalog exposes only registered tools with accurate desktop effects", () => {
  const desktopTools = [
    {
      name: "desktop.workspace.write_file",
      description: "Write a workspace file",
      inputSchema: { type: "object" },
      async execute() { return { ok: true }; },
    },
    {
      name: "desktop.process.run",
      description: "Run an allowlisted process",
      inputSchema: { type: "object" },
      async execute() { return { exitCode: 0 }; },
    },
    {
      name: "custom.read",
      description: "Custom tool with explicit read-only effects",
      inputSchema: { type: "object" },
      effects: ["read"] as const,
      async execute() { return { ok: true }; },
    },
    {
      name: "custom.unknown",
      description: "Custom tool with no effect declaration",
      inputSchema: { type: "object" },
      async execute() { return { ok: true }; },
    },
  ];
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: createToolRegistry([...createBuiltinTools(), ...desktopTools]) },
    defaultPolicy,
  );
  const catalog = gateway.listTools();
  assert.ok(catalog.some((tool) => tool.name === "desktop.workspace.write_file" && tool.effects.includes("write")));
  assert.ok(catalog.some((tool) => tool.name === "desktop.process.run" && tool.effects.includes("shell")));
  assert.equal(gateway.describe("desktop.process.run")?.effects.includes("shell"), true);
  assert.deepEqual(gateway.describe("custom.read")?.effects, ["read"]);
  assert.deepEqual(gateway.describe("custom.unknown")?.effects, ["destructive"]);
});


test("read-only browser tools can run without interactive approval while page actions remain gated", async () => {
  let observed = false;
  let clicked = false;
  const registry = new MapToolRegistry([
    {
      name: "browser.goto",
      description: "Navigate to a public page",
      inputSchema: { type: "object", properties: { pageId: { type: "string" }, url: { type: "string" } }, required: ["pageId", "url"] },
      async execute() { return { url: "https://example.com/" }; },
    },
    {
      name: "browser.observe",
      description: "Read page content",
      inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
      async execute() { observed = true; return { title: "Public page" }; },
    },
    {
      name: "browser.click",
      description: "Interact with a page",
      inputSchema: { type: "object", properties: { pageId: { type: "string" }, selector: { type: "string" } }, required: ["pageId", "selector"] },
      async execute() { clicked = true; return { ok: true }; },
    },
  ]);
  const policy = { ...defaultPolicy, allowNetwork: true, allowBrowser: true, allowedHosts: ["example.com"] };
  const gateway = new RegistryToolGateway({ runtime: runtime(), tools: registry }, policy);

  assert.deepEqual(gateway.describe("browser.observe")?.effects, ["read"]);
  assert.deepEqual(gateway.describe("browser.goto")?.effects, ["network", "read"]);
  assert.deepEqual(gateway.describe("browser.click")?.effects, ["browser", "network"]);

  const read = await gateway.execute(
    { tool: "browser.observe", input: { pageId: "page-1" } },
    { runId: "browser-read-test", principalId: "test-user", signal: new AbortController().signal, requireApproval: false, notifyApproval() {} },
  );
  assert.equal(read.ok, true);
  assert.equal(observed, true);

  const interaction = await gateway.execute(
    { tool: "browser.click", input: { pageId: "page-1", selector: "button" } },
    { runId: "browser-click-test", principalId: "test-user", signal: new AbortController().signal, requireApproval: false, notifyApproval() {} },
  );
  assert.equal(interaction.ok, false);
  assert.equal(interaction.error?.category, "permission_error");
  assert.match(interaction.error?.message ?? "", /url/i);
  assert.equal(clicked, false);
});

test("reserved tool names cannot downgrade inferred security effects", async () => {
  let executed = false;
  const registry = new MapToolRegistry([{
    name: "terminal.run",
    description: "Misconfigured terminal tool that claims read-only effects",
    inputSchema: { type: "object" },
    effects: ["read"] as const,
    async execute() { executed = true; return { ok: true }; },
  }, {
    name: "web.search",
    description: "Misconfigured search tool that claims read-only effects",
    inputSchema: { type: "object" },
    effects: ["read"] as const,
    async execute() { return { ok: true }; },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    defaultPolicy,
  );

  assert.deepEqual(gateway.describe("terminal.run")?.effects, ["shell", "network", "read"]);
  assert.deepEqual(gateway.describe("web.search")?.effects, ["network", "read"]);
  const result = await gateway.execute(
    { tool: "terminal.run", input: { command: "node", args: ["--version"] } },
    {
      runId: "tool-effect-downgrade-test",
      principalId: "test-principal",
      signal: new AbortController().signal,
      requireApproval: false,
      notifyApproval() {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.category, "permission_error");
  assert.equal(executed, false, "terminal execution must be denied while shell policy is disabled");
});


test("Brain tool gateway rejects invalid schema input before approval or execution", async () => {
  let approvalCalls = 0;
  let executions = 0;
  const registry = new MapToolRegistry([{
    name: "workspace.write_file",
    description: "Validated write tool",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute() { executions += 1; return { written: true }; },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    defaultPolicy,
    async () => { approvalCalls += 1; return true; },
  );

  const result = await gateway.execute(
    { tool: "workspace.write_file", input: { path: "safe.txt" } },
    {
      runId: "brain-tool-schema-validation",
      principalId: "test-principal",
      signal: new AbortController().signal,
      requireApproval: true,
      notifyApproval() {},
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.category, "tool_error");
  assert.match(result.error?.message ?? "", /missing required property "content"/i);
  assert.equal(approvalCalls, 0, "malformed input must be rejected before prompting for approval");
  assert.equal(executions, 0, "malformed input must never reach the tool implementation");
});


test("tool gateway redacts provider tokens, private keys, tool outputs, errors, and arbitrary audit sinks", async () => {
  const events: SecurityAuditEvent[] = [];
  const audit: SecurityAuditSink = { record(event) { events.push(event); } };
  const registry = new MapToolRegistry([
    {
      name: "custom.read",
      description: "Return secret-shaped test data",
      inputSchema: { type: "object" },
      effects: ["read"] as const,
      async execute() {
        return {
          apiKey: "sk-live-secret-value",
          message: "Authorization: Bearer abcdef123456",
          freeText: "unlabelled key sk-12345678901234567890",
          githubToken: "ghp_1234567890123456789012345",
          awsKey: "AKIA1234567890ABCDEF",
          snippet: "-----BEGIN PRIVATE KEY-----\\nprivate material\\n-----END PRIVATE KEY-----",
          nested: { password: "hunter2" },
        };
      },
    },
    {
      name: "custom.fail",
      description: "Throw a fixture containing secret-shaped values",
      inputSchema: { type: "object" },
      effects: ["read"] as const,
      async execute() { throw new Error("api_key=sk-error-secret-value"); },
    },
  ]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    defaultPolicy,
    undefined,
    undefined,
    undefined,
    audit,
  );
  const context = {
    runId: "redaction-test",
    principalId: "test-principal",
    signal: new AbortController().signal,
    requireApproval: false,
    notifyApproval() {},
  };

  const success = await gateway.execute(
    { tool: "custom.read", input: { apiKey: "sk-input-secret-value" } },
    context,
  );
  assert.equal(success.ok, true);
  const serialized = JSON.stringify(success.data);
  for (const secret of [
    "sk-live-secret-value",
    "sk-12345678901234567890",
    "ghp_1234567890123456789012345",
    "AKIA1234567890ABCDEF",
    "abcdef123456",
    "private material",
    "hunter2",
    "sk-input-secret-value",
  ]) {
    assert.equal(serialized.includes(secret), false, "tool result must not expose " + secret);
  }
  assert.equal(serialized.includes("[REDACTED PRIVATE KEY]"), true);

  const failure = await gateway.execute({ tool: "custom.fail", input: {} }, context);
  assert.equal(failure.ok, false);
  assert.equal(failure.error?.message.includes("sk-error-secret-value"), false);

  const auditText = JSON.stringify(events);
  for (const secret of ["sk-live-secret-value", "sk-input-secret-value", "sk-error-secret-value", "hunter2", "private material"]) {
    assert.equal(auditText.includes(secret), false, "audit sink must not receive " + secret);
  }
});


test("capability discovery reports policy availability instead of exposing every registered tool as ready", () => {
  const registry = new MapToolRegistry([
    { name: "workspace.search", description: "Search workspace", inputSchema: { type: "object" }, effects: ["read"] as const, async execute() { return {}; } },
    { name: "web.search", description: "Search web", inputSchema: { type: "object" }, effects: ["network", "read"] as const, async execute() { return {}; } },
    { name: "workspace.write_file", description: "Write file", inputSchema: { type: "object" }, effects: ["write"] as const, async execute() { return {}; } },
    { name: "terminal.run", description: "Run terminal", inputSchema: { type: "object" }, effects: ["shell"] as const, async execute() { return {}; } },
  ]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowNetwork: true, allowShell: true, allowFileWrite: true, allowedHosts: ["api.search.brave.com"] },
    async () => true,
  );
  const capabilities = Object.fromEntries(gateway.listTools().map(tool => [tool.name, tool.policy]));
  assert.deepEqual(capabilities["workspace.search"], { status: "allowed", reason: undefined });
  assert.deepEqual(capabilities["web.search"], { status: "allowed", reason: undefined });
  assert.deepEqual(capabilities["workspace.write_file"], { status: "approval_required", reason: "Approval is required before execution." });
  assert.deepEqual(capabilities["terminal.run"], { status: "approval_required", reason: "Approval is required before execution." });

  const noApproval = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowFileWrite: true },
  );
  const write = noApproval.listTools().find(tool => tool.name === "workspace.write_file");
  assert.equal(write?.policy?.status, "blocked");
  assert.match(write?.policy?.reason ?? "", /no approval handler/i);
});


test("browser readiness uses a registered safe probe once for all browser tools", async () => {
  let probeCalls = 0;
  const probeReadiness = async () => {
    probeCalls += 1;
    return { ok: true, reason: "Isolated browser launch passed." };
  };
  const registry = new MapToolRegistry([
    { name: "browser.open", description: "Open browser", inputSchema: { type: "object" }, effects: ["browser"] as const, probeReadiness, async execute() { return {}; } },
    { name: "browser.goto", description: "Navigate browser", inputSchema: { type: "object" }, effects: ["browser"] as const, probeReadiness, async execute() { return {}; } },
  ]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowBrowser: true, allowNetwork: true, allowedHosts: ["example.com"] },
    async () => true,
  );
  const catalog = await gateway.probeReadiness();
  assert.equal(probeCalls, 1);
  assert.equal(catalog[0]?.runtimeReadiness, "ready");
  assert.equal(catalog[1]?.runtimeReadiness, "ready");
  assert.match(catalog[0]?.runtimeReason ?? "", /isolated browser launch passed/i);
});

test("browser readiness probe is skipped when execution policy blocks the browser", async () => {
  let probeCalls = 0;
  const registry = new MapToolRegistry([
    {
      name: "browser.open",
      description: "Open browser",
      inputSchema: { type: "object" },
      effects: ["browser"] as const,
      async probeReadiness() { probeCalls += 1; return { ok: true, reason: "unexpected probe" }; },
      async execute() { return {}; },
    },
  ]);
  const gateway = new RegistryToolGateway({ runtime: runtime(), tools: registry }, defaultPolicy);
  const capability = (await gateway.probeReadiness())[0];
  assert.equal(probeCalls, 0);
  assert.equal(capability?.policy?.status, "blocked");
  assert.equal(capability?.runtimeReadiness, "not_probed");
  assert.match(capability?.runtimeReason ?? "", /policy blocks/i);
});

test("network capability discovery explains missing host allowlist", () => {
  const registry = new MapToolRegistry([
    { name: "web.search", description: "Search web", inputSchema: { type: "object" }, effects: ["network", "read"] as const, async execute() { return {}; } },
  ]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowNetwork: true, allowedHosts: [] },
  );
  const capability = gateway.listTools()[0];
  assert.equal(capability?.policy?.status, "blocked");
  assert.match(capability?.policy?.reason ?? "", /allowed-host/i);
});

test("network capability discovery blocks tools when network access is disabled", () => {
  const registry = new MapToolRegistry([
    { name: "web.search", description: "Search web", inputSchema: { type: "object" }, effects: ["network", "read"] as const, async execute() { return {}; } },
  ]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowNetwork: false, allowedHosts: ["api.search.brave.com"] },
  );
  const capability = gateway.listTools()[0];
  assert.equal(capability?.policy?.status, "blocked");
  assert.match(capability?.policy?.reason ?? "", /network access is disabled/i);
});


test("capability discovery never claims runtime readiness and reflects the security kill switch", () => {
  const registry = new MapToolRegistry([
    { name: "workspace.search", description: "Search workspace", inputSchema: { type: "object" }, effects: ["read"] as const, async execute() { return {}; } },
  ]);
  const security = new SecurityController();
  const gateway = new RegistryToolGateway({ runtime: runtime(), tools: registry }, defaultPolicy, undefined, undefined, security);
  const before = gateway.listTools()[0];
  assert.equal(before?.registered, true);
  assert.equal(before?.policy?.status, "allowed");
  assert.equal(before?.runtimeReadiness, "not_probed");
  security.kill("operator emergency stop");
  const after = gateway.listTools()[0];
  assert.equal(after?.policy?.status, "blocked");
  assert.match(after?.policy?.reason ?? "", /kill switch/i);
});

test("runtime readiness probe confirms workspace only after read-only runtime checks", async () => {
  const readyGateway = new RegistryToolGateway(
    { runtime: runtime(), tools: createToolRegistry(createBuiltinTools()) },
    defaultPolicy,
  );
  const ready = await readyGateway.probeReadiness();
  const workspace = ready.find((tool) => tool.name === "workspace.read_file");
  assert.equal(workspace?.registered, true);
  assert.equal(workspace?.runtimeReadiness, "ready");
  assert.match(workspace?.runtimeReason ?? "", /read-only/i);

  const unavailableRuntime = {
    ...runtime(),
    async listFiles() { throw new Error("workspace mount is unavailable"); },
  } satisfies WorkspaceRuntime;
  const unavailableGateway = new RegistryToolGateway(
    { runtime: unavailableRuntime, tools: createToolRegistry(createBuiltinTools()) },
    defaultPolicy,
  );
  const unavailable = await unavailableGateway.probeReadiness();
  const failedWorkspace = unavailable.find((tool) => tool.name === "workspace.read_file");
  assert.equal(failedWorkspace?.runtimeReadiness, "unavailable");
  assert.match(failedWorkspace?.runtimeReason ?? "", /workspace mount is unavailable/i);
});

test("runtime readiness never claims browser or terminal is ready without a real safe probe", async () => {
  const registry = new MapToolRegistry([
    {
      name: "browser.observe",
      description: "Observe an existing browser page",
      inputSchema: { type: "object" },
      effects: ["read"] as const,
      async execute() { return { title: "test" }; },
    },
    {
      name: "terminal.run",
      description: "Run an approved command",
      inputSchema: { type: "object" },
      effects: ["shell"] as const,
      async execute() { return { code: 0 }; },
    },
  ]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, allowShell: true },
  );
  const catalog = await gateway.probeReadiness();
  const browser = catalog.find((tool) => tool.name === "browser.observe");
  const terminal = catalog.find((tool) => tool.name === "terminal.run");
  assert.equal(browser?.runtimeReadiness, "not_probed");
  assert.equal(terminal?.runtimeReadiness, "not_probed");
  assert.match(browser?.runtimeReason ?? "", /browser-session probe/i);
  assert.match(terminal?.runtimeReason ?? "", /not invoked/i);
});


test("tool approval receives the authenticated principal and trusted notification destination", async () => {
  let approval: { requestId?: string; principalId?: string; notificationChannelId?: string; signal?: AbortSignal } | undefined;
  let toolApprovalEvidence: { requestId: string; runId: string; principalId: string; toolName: string; actionHash: string } | undefined;
  const registry = new MapToolRegistry([{
    name: "workspace.write_file",
    description: "Write a file after explicit approval",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async execute(_input, context) { toolApprovalEvidence = context.approval; return { written: true }; },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    defaultPolicy,
    async (request) => {
      approval = {
        requestId: request.requestId,
        principalId: request.principalId,
        notificationChannelId: request.notificationChannelId,
        signal: request.signal,
      };
      return true;
    },
  );
  const controller = new AbortController();
  const result = await gateway.execute(
    { tool: "workspace.write_file", input: { path: "src/approved.txt", content: "approved" } },
    {
      runId: "approval-notification-context-test",
      principalId: "discord:12345",
      notificationChannelId: "67890",
      signal: controller.signal,
      requireApproval: true,
      notifyApproval() {},
    },
  );
  assert.equal(result.ok, true);
  assert.equal(approval?.requestId, toolApprovalEvidence?.requestId);
  assert.ok(approval?.requestId);
  assert.equal(toolApprovalEvidence?.runId, "approval-notification-context-test");
  assert.equal(toolApprovalEvidence?.principalId, "discord:12345");
  assert.equal(toolApprovalEvidence?.toolName, "workspace.write_file");
  assert.match(toolApprovalEvidence?.actionHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(approval?.principalId, "discord:12345");
  assert.equal(approval?.notificationChannelId, "67890");
  assert.equal(approval?.signal, controller.signal);
});
