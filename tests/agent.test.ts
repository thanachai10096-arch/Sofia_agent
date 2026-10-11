import test from "node:test";
import assert from "node:assert/strict";
import { SofiaAgent } from "../src/agent/core.js";
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

import { createToolRegistry } from "../src/tools/registry.js";
import { defaultPolicy } from "../src/security/policy.js";

test("agent requires explicit approval before executing a write tool", async () => {
  let executed = false;
  const agent = new SofiaAgent({
    provider: { async generate() { return { text: "", toolCalls: [{ id: "write-1", name: "workspace.write_file", input: { path: "src/a.ts", content: "example" } }] }; } },
    router: new ModelRouter([{ id: "primary", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 1, healthy: true }]),
    reviewer: new Reviewer(),
    runtime: {} as never,
    tools: createToolRegistry([{ name: "workspace.write_file", description: "Write a workspace file", inputSchema: { type: "object" }, effects: ["write"], async execute() { executed = true; return { ok: true }; } }]),
    policy: { ...defaultPolicy, maxSteps: 1 },
  });
  await assert.rejects(() => agent.run({ task: "write a file", maxSteps: 1 }), /Approval handler required/);
  assert.equal(executed, false);
});

import { SecurityController } from "../src/security/controller.js";

test("agent refuses to start when the security kill switch is active", async () => {
  let called = false;
  const securityController = new SecurityController();
  securityController.kill("test stop");
  const agent = new SofiaAgent({
    provider: { async generate() { called = true; return { text: "should not run" }; } },
    router: new ModelRouter([{ id: "primary", capabilities: ["coding", "reasoning"], costWeight: 1, latencyWeight: 1, qualityWeight: 1, healthy: true }]),
    reviewer: new Reviewer(),
    securityController,
  });
  await assert.rejects(() => agent.run({ task: "simple task" }), /kill switch is active/);
  assert.equal(called, false);
});
