import assert from "node:assert/strict";
import test from "node:test";
import { RegistryToolGateway } from "./registry-tool-gateway.js";
import { ApprovalBroker, InMemoryApprovalDecisionStore } from "../agent/approval-broker.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import { createToolRegistry } from "../tools/registry.js";
import { createBuiltinTools } from "../tools/builtin.js";
import { defaultPolicy } from "../security/policy.js";
import { SecurityController } from "../security/controller.js";
import type { SecurityAuditEvent, SecurityAuditSink } from "../security/audit.js";
import { findIndeterminateExecutions, reconcileIndeterminateExecutions } from "../security/audit.js";
import { MapToolRegistry } from "../tools/types.js";

test("receipt reconciliation flags orphaned and mismatched executions without replaying them", () => {
  const started = (id: string, actionHash = "action-hash"): SecurityAuditEvent => ({
    id,
    at: "2026-11-19T00:00:00.000Z",
    runId: "run-1",
    principalId: "owner-1",
    toolName: "workspace.write_file",
    actionHash,
    risk: "low",
    decision: "execution_started",
  });
  const startCompleted = started("start-completed");
  const startFailed = started("start-failed");
  const orphan = started("start-orphan");
  const mismatched = started("start-mismatched");
  const events: SecurityAuditEvent[] = [
    startCompleted,
    startFailed,
    orphan,
    mismatched,
    {
      ...startCompleted,
      id: "completed",
      relatedEventId: startCompleted.id,
      decision: "completed",
    },
    {
      ...startFailed,
      id: "failed",
      relatedEventId: startFailed.id,
      decision: "failed",
    },
    {
      ...mismatched,
      id: "wrong-action-terminal",
      relatedEventId: mismatched.id,
      actionHash: "different-action",
      decision: "completed",
    },
  ];

  assert.deepEqual(
    findIndeterminateExecutions(events).map((event) => event.id).sort(),
    ["start-mismatched", "start-orphan"],
  );
});

test("receipt reconciliation keeps duplicate start IDs indeterminate even with a matching terminal event", () => {
  const started = (actionHash: string): SecurityAuditEvent => ({
    id: "duplicated-start-id",
    at: "2026-11-20T00:00:00.000Z",
    runId: "run-duplicate",
    principalId: "owner-duplicate",
    toolName: "external.purchase",
    actionHash,
    risk: "high",
    decision: "execution_started",
  });
  const first = started("action-one");
  const second = started("action-two");
  const terminal: SecurityAuditEvent = {
    ...first,
    id: "terminal-one",
    relatedEventId: first.id,
    decision: "completed",
  };
  assert.deepEqual(
    findIndeterminateExecutions([first, second, terminal]).map((event) => event.actionHash).sort(),
    ["action-one", "action-two"],
    "ambiguous duplicate receipt IDs must never be treated as safely resolved",
  );
});

test("durable receipt reconciliation reads journal state and never replays actions", async () => {
  const events: SecurityAuditEvent[] = [{
    id: "orphaned-start",
    at: "2026-11-19T00:00:00.000Z",
    runId: "restart-run",
    principalId: "owner-1",
    toolName: "external.purchase",
    actionHash: "action-1",
    risk: "high",
    decision: "execution_started",
  }];
  let listCalls = 0;
  const sink: SecurityAuditSink = {
    durable: true,
    record() {},
    read(id) { return events.find((event) => event.id === id); },
    list() { listCalls += 1; return events; },
  };
  const unresolved = await reconcileIndeterminateExecutions(sink);
  assert.equal(listCalls, 1);
  assert.deepEqual(unresolved.map((event) => event.id), ["orphaned-start"]);
  assert.equal(events.length, 1, "reconciliation must not mutate or replay the action");
  await assert.rejects(
    reconcileIndeterminateExecutions({ record() {}, read() { return undefined; } }),
    /durable, enumerable audit sink/i,
  );
});

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

test("approved actions are audited with the exact action hash before execution", async () => {
  let executions = 0;
  const events: SecurityAuditEvent[] = [];
  const registry = new MapToolRegistry([{
    name: "custom.write",
    description: "Approved write action",
    inputSchema: { type: "object" },
    effects: ["write"] as const,
    async execute() { executions += 1; return { committed: true }; },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, capabilitySecret: "approval-approved-audit-test-secret" },
    async (request) => {
      assert.equal(request.principalId, "principal-approval-audit");
      assert.match(request.actionHash, /^[a-f0-9]{64}$/);
      return true;
    },
    undefined,
    undefined,
    { record(event) { events.push(event); } },
  );
  const result = await gateway.execute(
    { tool: "custom.write", input: { value: "approved" } },
    {
      runId: "approval-approved-audit",
      principalId: "principal-approval-audit",
      signal: new AbortController().signal,
      requireApproval: true,
      notifyApproval() {},
    },
  );
  assert.equal(result.ok, true);
  assert.equal(executions, 1);
  const approved = events.find((event) => event.decision === "approval_approved");
  const completed = events.find((event) => event.decision === "completed");
  assert.ok(approved);
  assert.ok(completed);
  assert.equal(approved.actionHash, completed.actionHash);
  assert.equal(approved.principalId, completed.principalId);
});

test("production effectful execution persists and verifies a start receipt before invoking the tool", async () => {
  const previousSofia = process.env.SOFIA_ENV;
  process.env.SOFIA_ENV = "production";
  try {
    let executions = 0;
    const events = new Map<string, SecurityAuditEvent>();
    const order: string[] = [];
    const audit: SecurityAuditSink = {
      durable: true,
      record(event) { events.set(event.id, event); order.push(event.decision); },
      read(id) { return events.get(id); },
      list() { return [...events.values()]; },
    };
    const registry = new MapToolRegistry([{
      name: "custom.write",
      description: "Production write with an execution receipt",
      inputSchema: { type: "object" },
      effects: ["write"] as const,
      async execute() { executions += 1; order.push("tool_invoked"); return { committed: true }; },
    }]);
    const gateway = new RegistryToolGateway(
      { runtime: runtime(), tools: registry },
      { ...defaultPolicy, capabilitySecret: "execution-start-receipt-production-secret" },
      async () => true,
      undefined,
      undefined,
      audit,
    );
    const result = await gateway.execute(
      { tool: "custom.write", input: { value: "commit" } },
      {
        runId: "execution-start-receipt-test",
        principalId: "authenticated-owner",
        signal: new AbortController().signal,
        requireApproval: true,
        notifyApproval() {},
      },
    );
    assert.equal(result.ok, true);
    assert.equal(executions, 1);
    assert.ok(order.indexOf("execution_started") >= 0);
    assert.ok(order.indexOf("execution_started") < order.indexOf("tool_invoked"));
    assert.ok(order.indexOf("tool_invoked") < order.indexOf("completed"));
    const started = [...events.values()].find((event) => event.decision === "execution_started");
    const completed = [...events.values()].find((event) => event.decision === "completed");
    assert.ok(started);
    assert.ok(completed);
    assert.equal(started.runId, completed.runId);
    assert.equal(started.principalId, completed.principalId);
    assert.equal(started.actionHash, completed.actionHash);
    assert.equal(started.toolName, completed.toolName);
    assert.equal(completed.relatedEventId, started.id, "terminal receipt must reference its exact execution-start record");
  } finally {
    if (previousSofia === undefined) delete process.env.SOFIA_ENV;
    else process.env.SOFIA_ENV = previousSofia;
  }
});

test("production blocks effectful execution when its execution-start receipt cannot be read back", async () => {
  const previousSofia = process.env.SOFIA_ENV;
  process.env.SOFIA_ENV = "production";
  try {
    let executions = 0;
    const events = new Map<string, SecurityAuditEvent>();
    const audit: SecurityAuditSink = {
      durable: true,
      record(event) { events.set(event.id, event); },
      read(id) {
        const event = events.get(id);
        return event?.decision === "approval_approved" ? event : undefined;
      },
      list() { return [...events.values()]; },
    };
    const registry = new MapToolRegistry([{
      name: "custom.write",
      description: "Write blocked when execution intent cannot be verified",
      inputSchema: { type: "object" },
      effects: ["write"] as const,
      async execute() { executions += 1; return { committed: true }; },
    }]);
    const gateway = new RegistryToolGateway(
      { runtime: runtime(), tools: registry },
      { ...defaultPolicy, capabilitySecret: "execution-start-receipt-missing-secret" },
      async () => true,
      undefined,
      undefined,
      audit,
    );
    const result = await gateway.execute(
      { tool: "custom.write", input: { value: "must-not-run" } },
      {
        runId: "execution-start-receipt-missing-test",
        principalId: "authenticated-owner",
        signal: new AbortController().signal,
        requireApproval: true,
        notifyApproval() {},
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error?.message ?? "", /execution-start receipt/i);
    assert.equal(executions, 0);
  } finally {
    if (previousSofia === undefined) delete process.env.SOFIA_ENV;
    else process.env.SOFIA_ENV = previousSofia;
  }
});

test("production approval fails closed when the approval audit event cannot be read back", async () => {
  let executions = 0;
  const previousSofia = process.env.SOFIA_ENV;
  process.env.SOFIA_ENV = "production";
  try {
    const registry = new MapToolRegistry([{
      name: "custom.write",
      description: "Write requiring verified approval evidence",
      inputSchema: { type: "object" },
      effects: ["write"] as const,
      async execute() { executions += 1; return { committed: true }; },
    }]);
    const audit: SecurityAuditSink = {
      durable: true,
      record() {},
      read() { return undefined; },
      list() { return []; },
    };
    const gateway = new RegistryToolGateway(
      { runtime: runtime(), tools: registry },
      { ...defaultPolicy, capabilitySecret: "production-approval-evidence-test-secret" },
      async () => true,
      undefined,
      undefined,
      audit,
    );
    const result = await gateway.execute(
      { tool: "custom.write", input: { value: "must-not-run" } },
      {
        runId: "production-approval-evidence-missing",
        principalId: "principal-approval-evidence",
        signal: new AbortController().signal,
        requireApproval: true,
        notifyApproval() {},
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.category, "permission_error");
    assert.match(result.error?.message ?? "", /approval audit evidence/i);
    assert.equal(executions, 0, "the side effect must not run without durable approval evidence");
  } finally {
    if (previousSofia === undefined) delete process.env.SOFIA_ENV;
    else process.env.SOFIA_ENV = previousSofia;
  }
});

test("production blocks an approved write when approval audit readback cannot be verified", async () => {
  let executions = 0;
  const previousSofia = process.env.SOFIA_ENV;
  process.env.SOFIA_ENV = "production";
  try {
    const registry = new MapToolRegistry([{
      name: "custom.write",
      description: "Write action whose approval evidence cannot be read back",
      inputSchema: { type: "object" },
      effects: ["write"] as const,
      async execute() { executions += 1; return { committed: true }; },
    }]);
    const audit: SecurityAuditSink = {
      durable: true,
      record() {},
      read() { return undefined; },
      list() { return []; },
    };
    const gateway = new RegistryToolGateway(
      { runtime: runtime(), tools: registry },
      { ...defaultPolicy, capabilitySecret: "production-approval-audit-test-secret" },
      async () => true,
      undefined,
      undefined,
      audit,
    );
    const result = await gateway.execute(
      { tool: "custom.write", input: { path: "safe.txt", content: "must-not-run" } },
      {
        runId: "production-approval-audit-readback",
        principalId: "authenticated-principal",
        signal: new AbortController().signal,
        requireApproval: true,
        notifyApproval() {},
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.category, "permission_error");
    assert.match(result.error?.message ?? "", /approval audit evidence/i);
    assert.equal(executions, 0, "a missing approval audit readback must block the side effect");
  } finally {
    if (previousSofia === undefined) delete process.env.SOFIA_ENV;
    else process.env.SOFIA_ENV = previousSofia;
  }
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


test("completion audit failure does not turn a successful side effect into a retryable tool failure", async () => {
  let executions = 0;
  const registry = new MapToolRegistry([{
    name: "custom.write",
    description: "Successful side effect with a failing completion audit",
    inputSchema: { type: "object" },
    effects: ["read"] as const,
    async execute() { executions += 1; return { committed: true }; },
  }]);
  const audit: SecurityAuditSink = {
    record(event) {
      if (event.decision === "completed") throw new Error("audit storage unavailable");
    },
  };
  const gateway = new RegistryToolGateway({ runtime: runtime(), tools: registry }, defaultPolicy, undefined, undefined, undefined, audit);
  const result = await gateway.execute(
    { tool: "custom.write", input: {} },
    { runId: "audit-completion-failure", principalId: "test-principal", signal: new AbortController().signal, requireApproval: false, notifyApproval() {} },
  );

  assert.equal(executions, 1);
  assert.equal(result.ok, true, "the completed side effect must not be reported as failed");
  assert.equal(result.evidenceId, "", "an unpersisted completion audit must not be presented as evidence");
  assert.deepEqual(result.data, { committed: true });
  assert.match(result.warnings?.[0] ?? "", /completion audit event could not be persisted/i);
});

test("failure audit storage errors do not mask the original tool failure", async () => {
  const registry = new MapToolRegistry([{
    name: "custom.fail",
    description: "Failing operation with a failing failure audit",
    inputSchema: { type: "object" },
    effects: ["read"] as const,
    async execute() { throw new Error("original tool failure"); },
  }]);
  const audit: SecurityAuditSink = {
    record(event) {
      if (event.decision === "failed") throw new Error("audit storage unavailable");
    },
  };
  const gateway = new RegistryToolGateway({ runtime: runtime(), tools: registry }, defaultPolicy, undefined, undefined, undefined, audit);
  const result = await gateway.execute(
    { tool: "custom.fail", input: {} },
    { runId: "audit-failure-storage-error", principalId: "test-principal", signal: new AbortController().signal, requireApproval: false, notifyApproval() {} },
  );

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /original tool failure/);
  assert.match(result.warnings?.[0] ?? "", /failure event could not persist/i);
});


test("production gateway rejects missing or malformed authenticated principals", async () => {
  const previousNode = process.env.NODE_ENV;
  const previousSofia = process.env.SOFIA_ENV;
  process.env.SOFIA_ENV = "production";
  try {
    const gateway = new RegistryToolGateway({ runtime: runtime(), tools: createToolRegistry(createBuiltinTools()) }, {
      ...defaultPolicy,
      capabilitySecret: "test-capability-secret",
    });
    const result = await gateway.execute(
      { tool: "workspace.list_files", input: {} },
      { runId: "production-principal-required", signal: new AbortController().signal, requireApproval: false, notifyApproval() {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.category, "permission_error");
    assert.match(result.error?.message ?? "", /authenticated principal/i);
  } finally {
    if (previousNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNode;
    if (previousSofia === undefined) delete process.env.SOFIA_ENV; else process.env.SOFIA_ENV = previousSofia;
  }
});

test("rejected approval is audited and never executes the tool", async () => {
  let executions = 0;
  const events: SecurityAuditEvent[] = [];
  const registry = new MapToolRegistry([{
    name: "custom.write",
    description: "Write action requiring approval",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    effects: ["write"] as const,
    async execute() { executions += 1; return { committed: true }; },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, capabilitySecret: "approval-lifecycle-test-secret" },
    async (request) => {
      assert.equal(request.runId, "approval-rejected");
      assert.equal(request.principalId, "test-principal");
      assert.equal(request.toolName, "custom.write");
      assert.match(request.actionHash, /^[a-f0-9]{64}$/);
      return false;
    },
    undefined,
    undefined,
    { record(event) { events.push(event); } },
  );

  const result = await gateway.execute(
    { tool: "custom.write", input: { value: "approved-only-if-accepted" } },
    {
      runId: "approval-rejected",
      principalId: "test-principal",
      signal: new AbortController().signal,
      requireApproval: false,
      notifyApproval() {},
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.category, "permission_error");
  assert.match(result.error?.message ?? "", /not approved/i);
  assert.equal(executions, 0);
  assert.ok(events.some((event) => event.decision === "approval_required"));
  assert.ok(events.some((event) => event.decision === "approval_denied"));
});

test("an approval arriving after capability expiry cannot execute the tool", async () => {
  let executions = 0;
  const registry = new MapToolRegistry([{
    name: "custom.write",
    description: "Write action requiring approval",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    effects: ["write"] as const,
    async execute() { executions += 1; return { committed: true }; },
  }]);
  const previousSofia = process.env.SOFIA_ENV;
  const originalNow = Date.now;
  let fakeNow = originalNow();
  process.env.SOFIA_ENV = "production";
  Date.now = () => fakeNow;
  try {
    const gateway = new RegistryToolGateway(
      { runtime: runtime(), tools: registry },
      { ...defaultPolicy, capabilitySecret: "approval-expiry-test-secret" },
      async () => {
        fakeNow += 60_001;
        return true;
      },
    );

    const result = await gateway.execute(
      { tool: "custom.write", input: { value: "must-not-run-after-expiry" } },
      {
        runId: "approval-expired",
        principalId: "test-principal",
        signal: new AbortController().signal,
        requireApproval: false,
        notifyApproval() {},
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.category, "permission_error");
    assert.match(result.error?.message ?? "", /capability validation failed/i);
    assert.equal(executions, 0);
  } finally {
    Date.now = originalNow;
    if (previousSofia === undefined) delete process.env.SOFIA_ENV;
    else process.env.SOFIA_ENV = previousSofia;
  }
});



test("production effectful tools fail closed when no audit sink is configured", async () => {
  let executions = 0;
  const previousSofia = process.env.SOFIA_ENV;
  process.env.SOFIA_ENV = "production";
  try {
    const registry = new MapToolRegistry([{
      name: "custom.write",
      description: "Write action requiring durable audit configuration",
      inputSchema: { type: "object" },
      effects: ["write"] as const,
      async execute() { executions += 1; return { committed: true }; },
    }]);
    const gateway = new RegistryToolGateway(
      { runtime: runtime(), tools: registry },
      { ...defaultPolicy, capabilitySecret: "production-audit-required-test-secret" },
    );
    const result = await gateway.execute(
      { tool: "custom.write", input: {} },
      { runId: "production-audit-required", principalId: "test-principal", signal: new AbortController().signal, requireApproval: false, notifyApproval() {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.category, "permission_error");
    assert.match(result.error?.message ?? "", /security audit sink/i);
    assert.equal(executions, 0);
  } finally {
    if (previousSofia === undefined) delete process.env.SOFIA_ENV;
    else process.env.SOFIA_ENV = previousSofia;
  }
});




test("durable completion readback rejects a receipt for a different principal or tool", async () => {
  let executions = 0;
  const previousSofia = process.env.SOFIA_ENV;
  process.env.SOFIA_ENV = "production";
  try {
    const persisted = new Map<string, SecurityAuditEvent>();
    const audit: SecurityAuditSink = {
      durable: true,
      record(event) {
        persisted.set(event.id, event.decision === "completed"
          ? { ...event, principalId: "different-principal" }
          : event);
      },
      read(id) { return persisted.get(id); },
      list() { return [...persisted.values()]; },
    };
    const registry = new MapToolRegistry([{
      name: "custom.write",
      description: "Write with deliberately mismatched completion evidence",
      inputSchema: { type: "object" },
      effects: ["write"] as const,
      async execute() { executions += 1; return { committed: true }; },
    }]);
    const gateway = new RegistryToolGateway(
      { runtime: runtime(), tools: registry },
      { ...defaultPolicy, capabilitySecret: "completion-readback-mismatch-test-secret" },
      async () => true,
      undefined,
      undefined,
      audit,
    );
    const result = await gateway.execute(
      { tool: "custom.write", input: { value: "commit" } },
      {
        runId: "completion-readback-mismatch",
        principalId: "authenticated-owner",
        signal: new AbortController().signal,
        requireApproval: true,
        notifyApproval() {},
      },
    );
    assert.equal(executions, 1, "the side effect already completed and must not be retried");
    assert.equal(result.ok, true);
    assert.equal(result.evidenceId, "", "mismatched evidence must not be exposed as verified");
    assert.match(result.warnings?.[0] ?? "", /completion audit event could not be persisted and read back/i);
  } finally {
    if (previousSofia === undefined) delete process.env.SOFIA_ENV;
    else process.env.SOFIA_ENV = previousSofia;
  }
});

test("tool evidence ID is the exact completion event confirmed by durable readback", async () => {
  const persisted = new Map<string, SecurityAuditEvent>();
  const audit: SecurityAuditSink = {
    durable: true,
    record(event) { persisted.set(event.id, event); },
    read(id) { return persisted.get(id); },
  };
  const registry = new MapToolRegistry([{
    name: "custom.read",
    description: "Read action with durable completion evidence",
    inputSchema: { type: "object" },
    effects: ["read"] as const,
    async execute() { return { value: "verified" }; },
  }]);
  const gateway = new RegistryToolGateway({ runtime: runtime(), tools: registry }, defaultPolicy, undefined, undefined, undefined, audit);
  const result = await gateway.execute(
    { tool: "custom.read", input: {} },
    { runId: "durable-evidence-readback", principalId: "test-principal", signal: new AbortController().signal, requireApproval: false, notifyApproval() {} },
  );
  assert.equal(result.ok, true);
  assert.ok(result.evidenceId);
  const event = persisted.get(result.evidenceId);
  assert.equal(event?.decision, "completed");
  assert.equal(event?.runId, "durable-evidence-readback");
});

test("tool evidence ID is empty when durable audit readback is missing", async () => {
  const audit: SecurityAuditSink = {
    durable: true,
    record() {},
    read() { return undefined; },
  };
  const registry = new MapToolRegistry([{
    name: "custom.read",
    description: "Read action with missing audit readback",
    inputSchema: { type: "object" },
    effects: ["read"] as const,
    async execute() { return { value: "executed" }; },
  }]);
  const gateway = new RegistryToolGateway({ runtime: runtime(), tools: registry }, defaultPolicy, undefined, undefined, undefined, audit);
  const result = await gateway.execute(
    { tool: "custom.read", input: {} },
    { runId: "missing-durable-readback", principalId: "test-principal", signal: new AbortController().signal, requireApproval: false, notifyApproval() {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.evidenceId, "");
  assert.match(result.warnings?.[0] ?? "", /persisted and read back/i);
});


test("approval broker keeps effectful tools blocked until the exact pending action is approved", async () => {
  const principalId = "approval-e2e-principal";
  const broker = new ApprovalBroker({
    store: new InMemoryApprovalDecisionStore(),
    pollIntervalMs: 25,
    ttlMs: 10_000,
  });
  let executions = 0;
  const registry = new MapToolRegistry([{
    name: "custom.write",
    description: "Write protected data after an explicit approval decision",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    effects: ["write"] as const,
    async execute(input) {
      executions += 1;
      return { saved: (input as { value: string }).value };
    },
  }]);
  const gateway = new RegistryToolGateway(
    { runtime: runtime(), tools: registry },
    { ...defaultPolicy, capabilitySecret: "approval-broker-e2e-test-secret" },
    broker.handle,
  );

  const execution = gateway.execute(
    { tool: "custom.write", input: { value: "approved-value" } },
    {
      runId: "approval-broker-e2e-run",
      principalId,
      signal: new AbortController().signal,
      requireApproval: true,
      notifyApproval() {},
    },
  );

  let pending = await broker.listPending(principalId);
  for (let attempt = 0; attempt < 100 && pending.length !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    pending = await broker.listPending(principalId);
  }
  assert.equal(pending.length, 1, "the gateway must publish a pending approval request");
  assert.equal(pending[0]?.runId, "approval-broker-e2e-run");
  assert.equal(pending[0]?.toolName, "custom.write");
  assert.equal(pending[0]?.input.value, "approved-value");
  assert.match(pending[0]?.actionHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(executions, 0, "the effectful tool must remain blocked while approval is pending");

  const approved = await broker.approve(pending[0]!.id, pending[0]!.actionHash, principalId);
  assert.equal(approved, true);
  const result = await execution;

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { saved: "approved-value" });
  assert.equal(executions, 1, "the tool must execute exactly once after approval");
  assert.deepEqual(await broker.listPending(principalId), []);
});
