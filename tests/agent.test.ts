import test from "node:test";
import assert from "node:assert/strict";
import { SofiaAgent } from "../src/agent/core.js";
import { actionHash } from "../src/security/guard.js";
import { ModelRouter } from "../src/models/router.js";
import { Reviewer } from "../src/review/reviewer.js";
import type { ModelProvider } from "../src/models/types.js";

test("agent retries after reviewer rejection and succeeds on fallback", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    async generate() {
      calls++;
      return { text: calls === 1 ? "TODO: not implemented" : "Implemented and verified." };
    },
  };

  const agent = new SofiaAgent({
    provider,
    router: new ModelRouter([
      { id: "primary", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 2, latencyWeight: 2, qualityWeight: 9, healthy: true },
      { id: "fallback", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 3, latencyWeight: 3, qualityWeight: 8, healthy: true },
    ]),
    reviewer: new Reviewer(),
  });

  const result = await agent.run({ task: "Fix the broken TypeScript build" });
  assert.equal(result.output, "Implemented and verified.");
  assert.equal(result.steps, 2);
});


test("security kill switch aborts active model calls and blocks new runs", async () => {
  const { SecurityController } = await import("../src/security/controller.js");
  const securityController = new SecurityController();
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const provider: ModelProvider = {
    generate(_request, _route, options) {
      const signal = options?.signal;
      assert.ok(signal, "agent must bind the security controller to the provider signal");
      markStarted();
      return new Promise((_, reject) => {
        const onAbort = () => {
          markAborted();
          reject(signal.reason ?? new Error("aborted"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const agent = new SofiaAgent({
    provider,
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    securityController,
  });

  const pending = agent.run({ task: "wait for cancellation" });
  await started;
  securityController.kill("operator emergency stop");
  await aborted;
  await assert.rejects(pending, /operator emergency stop|aborted/i);
  await assert.rejects(agent.run({ task: "must not start" }), /kill switch is active/);
});

test("legacy execution fails closed when a write tool has no approval handler", async () => {
  const { defaultPolicy } = await import("../src/security/policy.js");
  let executions = 0;
  const writeTool = {
    name: "workspace.write_file",
    description: "Write a file",
    effects: ["write"] as const,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute() { executions += 1; return { written: true }; },
  };
  const agent = new SofiaAgent({
    provider: {
      async generate() {
        return {
          text: "",
          toolCalls: [{ id: "write-1", name: "workspace.write_file", input: { path: "safe.txt", content: "data" } }],
        };
      },
    },
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    runtime: {} as never,
    tools: {
      get(name: string) { return name === writeTool.name ? writeTool : undefined; },
      list() { return [writeTool]; },
    },
    policy: { ...defaultPolicy, maxSteps: 1, allowFileWrite: true, maxRisk: "high", permissions: {} },
  });

  await assert.rejects(agent.run({ task: "write a file" }), /Approval handler required for medium-risk tool/);
  assert.equal(executions, 0, "the tool must not execute without explicit approval");
});

test("approval handler cannot mutate the action that Sofia executes", async () => {
  const { defaultPolicy } = await import("../src/security/policy.js");
  const originalInput = { path: "safe.txt", content: "approved content" };
  let executedInput: Record<string, unknown> | undefined;
  const writeTool = {
    name: "workspace.write_file",
    description: "Write a file",
    effects: ["write"] as const,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>) {
      executedInput = structuredClone(input);
      return { written: true };
    },
  };
  const agent = new SofiaAgent({
    provider: {
      async generate() {
        return {
          text: "",
          toolCalls: [{ id: "write-snapshot", name: "workspace.write_file", input: structuredClone(originalInput) }],
        };
      },
    },
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    runtime: {} as never,
    tools: {
      get(name: string) { return name === writeTool.name ? writeTool : undefined; },
      list() { return [writeTool]; },
    },
    policy: { ...defaultPolicy, maxSteps: 1, allowFileWrite: true, maxRisk: "high", permissions: {} },
    approval: async (request) => {
      assert.equal(request.actionHash, actionHash(request.runId, request.toolName, originalInput));
      request.input.path = "attacker.txt";
      request.input.content = "changed after approval";
      return true;
    },
  });

  await assert.rejects(agent.run({ task: "write an approved file" }), /failed after 1 steps/);
  assert.deepEqual(executedInput, originalInput);
});

test("security kill switch prevents an approved action from starting after cancellation", async () => {
  const { SecurityController } = await import("../src/security/controller.js");
  const { defaultPolicy } = await import("../src/security/policy.js");
  const securityController = new SecurityController();
  let markApprovalStarted!: () => void;
  let approve!: (approved: boolean) => void;
  let executions = 0;
  const approvalStarted = new Promise<void>((resolve) => { markApprovalStarted = resolve; });
  const approvalDecision = new Promise<boolean>((resolve) => { approve = resolve; });
  const writeTool = {
    name: "workspace.write_file",
    description: "Write a file",
    effects: ["write"] as const,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute() { executions += 1; return { written: true }; },
  };
  const agent = new SofiaAgent({
    provider: {
      async generate() {
        return {
          text: "",
          toolCalls: [{ id: "cancel-after-approval", name: "workspace.write_file", input: { path: "safe.txt", content: "data" } }],
        };
      },
    },
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    runtime: {} as never,
    tools: {
      get(name: string) { return name === writeTool.name ? writeTool : undefined; },
      list() { return [writeTool]; },
    },
    policy: { ...defaultPolicy, maxSteps: 1, allowFileWrite: true, maxRisk: "high", permissions: {} },
    approval: async () => {
      markApprovalStarted();
      return approvalDecision;
    },
    securityController,
  });

  const pending = agent.run({ task: "write only if still authorized" });
  await approvalStarted;
  securityController.kill("cancel while approval is pending");
  approve(true);

  await assert.rejects(pending, /cancel while approval is pending|kill switch is active/i);
  assert.equal(executions, 0, "a tool must not begin after cancellation while approval was pending");
});


test("legacy execution cannot downgrade a reserved terminal tool to read-only", async () => {
  const { defaultPolicy } = await import("../src/security/policy.js");
  let executions = 0;
  const terminalTool = {
    name: "terminal.run",
    description: "Terminal tool with a deliberately incorrect read-only declaration",
    effects: ["read"] as const,
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
      required: ["command"],
      additionalProperties: false,
    },
    async execute() { executions += 1; return { code: 0 }; },
  };
  const agent = new SofiaAgent({
    provider: {
      async generate() {
        return {
          text: "",
          toolCalls: [{ id: "terminal-downgrade", name: "terminal.run", input: { command: "node", args: ["--version"] } }],
        };
      },
    },
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    runtime: {} as never,
    tools: {
      get(name: string) { return name === terminalTool.name ? terminalTool : undefined; },
      list() { return [terminalTool]; },
    },
    policy: { ...defaultPolicy, maxSteps: 1, allowShell: false, allowNetwork: false, permissions: {} },
  });

  await assert.rejects(agent.run({ task: "run a terminal command" }), /Tool execution is disabled by policy: terminal\.run/);
  assert.equal(executions, 0, "the terminal tool must not execute when shell access is disabled");
});


test("an observer abort at tool.started prevents approval UI and tool execution", async () => {
  const { defaultPolicy } = await import("../src/security/policy.js");
  const controller = new AbortController();
  let approvals = 0;
  let executions = 0;
  const writeTool = {
    name: "workspace.write_file",
    description: "Write a file",
    effects: ["write"] as const,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute() { executions += 1; return { written: true }; },
  };
  const agent = new SofiaAgent({
    provider: {
      async generate() {
        return {
          text: "",
          toolCalls: [{ id: "quota-stop", name: "workspace.write_file", input: { path: "safe.txt", content: "data" } }],
        };
      },
    },
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    runtime: {} as never,
    tools: {
      get(name: string) { return name === writeTool.name ? writeTool : undefined; },
      list() { return [writeTool]; },
    },
    policy: { ...defaultPolicy, maxSteps: 1, allowFileWrite: true, maxRisk: "high", permissions: {} },
    approval: async () => { approvals += 1; return true; },
  });

  await assert.rejects(
    agent.run({
      task: "write a file",
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "tool.started") controller.abort(new Error("tool quota exceeded"));
      },
    }),
    /tool quota exceeded/,
  );
  assert.equal(approvals, 0, "quota abort must be honored before requesting approval");
  assert.equal(executions, 0, "quota abort must prevent the tool side effect");
});
