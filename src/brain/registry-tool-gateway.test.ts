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


test("medium-risk workspace writes run without interactive approval by default", async () => {
  const rt = runtime();
  const gateway = new RegistryToolGateway(
    { runtime: rt, tools: createToolRegistry(createBuiltinTools()) },
    defaultPolicy,
  );
  const result = await gateway.execute(
    { tool: "workspace.write_file", input: { path: "src/automatic.txt", content: "safe change" } },
    { runId: "flexible-approval-test", signal: new AbortController().signal, requireApproval: false, notifyApproval() {} },
  );
  assert.equal(result.ok, true);
  assert.equal(await rt.readFile("src/automatic.txt"), "safe change");
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
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    defaultPolicy,
  );

  assert.deepEqual(gateway.describe("terminal.run")?.effects, ["shell", "network", "read"]);
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


test("gateway forwards a single-use approval receipt bound to the approved action", async () => {
  const rt = runtime();
  let received: unknown;
  const registry = new MapToolRegistry([{
    name: "skill.test.privileged",
    description: "Privileged skill test tool",
    effects: ["destructive"] as const,
    inputSchema: { type: "object", properties: { operation: { type: "string" } }, required: ["operation"] },
    async execute(_input, context) {
      received = context.approval;
      return { executed: true };
    },
  }]);
  let approvedRequest: Record<string, unknown> | undefined;
  const gateway = new RegistryToolGateway(
    { runtime: rt, tools: registry },
    { ...defaultPolicy, allowDestructive: true, maxRisk: "critical" },
    async (request) => {
      approvedRequest = request as unknown as Record<string, unknown>;
      return true;
    },
  );

  const result = await gateway.execute(
    { tool: "skill.test.privileged", input: { operation: "rotate-key" } },
    {
      runId: "approval-receipt-test",
      principalId: "principal-1",
      signal: new AbortController().signal,
      requireApproval: true,
      notifyApproval() {},
    },
  );

  assert.equal(result.ok, true);
  assert.ok(approvedRequest);
  assert.deepEqual(received, {
    requestId: approvedRequest.requestId,
    runId: "approval-receipt-test",
    principalId: "principal-1",
    toolName: "skill.test.privileged",
    actionHash: approvedRequest.actionHash,
  });
});


test("approval preserves trusted messaging destination and cancellation signal", async () => {
  const controller = new AbortController();
  let received: import("../agent/approval.js").ApprovalRequest | undefined;
  const registry = new MapToolRegistry([{
    name: "workspace.write_file",
    description: "Controlled write tool for approval context propagation",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
    async execute() { return { written: true }; },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    defaultPolicy,
    async (request) => {
      received = request;
      return true;
    },
  );

  const result = await gateway.execute(
    { tool: "workspace.write_file", input: { path: "src/approved.txt", content: "approved" } },
    {
      runId: "approval-context-test",
      principalId: "principal-1",
      notificationChannelId: "telegram:trusted-chat",
      signal: controller.signal,
      requireApproval: true,
      notifyApproval() {},
    },
  );

  assert.equal(result.ok, true);
  assert.ok(received?.requestId);
  assert.equal(received?.notificationChannelId, "telegram:trusted-chat");
  assert.equal(received?.signal, controller.signal);
});


test("caller cancellation interrupts a pending approval wait", async () => {
  const controller = new AbortController();
  let approvalSignal: AbortSignal | undefined;
  let announceApproval!: () => void;
  const approvalReached = new Promise<void>((resolve) => { announceApproval = resolve; });
  const registry = new MapToolRegistry([{
    name: "workspace.write_file",
    description: "Controlled write tool for caller cancellation test",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    async execute() { throw new Error("Tool must not execute after cancellation"); },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    defaultPolicy,
    async (request) => {
      approvalSignal = request.signal;
      announceApproval();
      return new Promise<boolean>(() => {});
    },
  );

  const execution = gateway.execute(
    { tool: "workspace.write_file", input: { path: "src/cancelled.txt", content: "must not write" } },
    {
      runId: "caller-cancel-approval-test",
      signal: controller.signal,
      requireApproval: true,
      notifyApproval() {},
    },
  );

  await approvalReached;
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(execution, /caller cancelled/);
  assert.equal(approvalSignal, controller.signal);
  assert.equal(approvalSignal?.aborted, true);
});
