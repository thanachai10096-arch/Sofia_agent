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

  await agent.run({ task: "write an approved file" });
  assert.deepEqual(executedInput, originalInput);
});

