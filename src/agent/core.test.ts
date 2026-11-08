import assert from "node:assert/strict";
import test from "node:test";
import { SofiaAgent } from "./core.js";
import { SqliteApprovalQueue, createQueuedApprovalHandler } from "./approval-queue.js";
import { MapToolRegistry } from "../tools/types.js";
import { defaultPolicy } from "../security/policy.js";
import type { AgentDependencies } from "./types.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";

async function waitForPending(
  queue: SqliteApprovalQueue,
  ownerId: string,
): Promise<ReturnType<SqliteApprovalQueue["list"]>[number]> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const pending = queue.list(ownerId)[0];
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Agent Core did not enqueue an approval request.");
}

for (const approved of [true, false]) {
  test(`Agent Core executes a gated tool only after explicit approval (approved=${approved})`, async () => {
    const queue = await SqliteApprovalQueue.open(":memory:");
    let executions = 0;
    let modelCalls = 0;
    const toolName = "custom.write";
    const deps: AgentDependencies = {
      provider: {
        async generate() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              text: "",
              toolCalls: [{ id: "call-1", name: toolName, input: { value: "verified" } }],
            };
          }
          return { text: "Finished after the approval decision." };
        },
      },
      router: {
        select: () => ({
          id: "test-route", capabilities: ["tool-use"], costWeight: 1,
          latencyWeight: 1, qualityWeight: 1, healthy: true,
        }),
        markUnhealthy: () => undefined,
      },
      reviewer: { review: async () => ({ approved: true, reason: "Output accepted." }) },
      runtime: {} as WorkspaceRuntime,
      tools: new MapToolRegistry([{
        name: toolName,
        description: "Test a protected write action.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        effects: ["write"],
        async execute() {
          executions += 1;
          return { saved: true };
        },
      }]),
      policy: {
        ...defaultPolicy,
        permissions: { [toolName]: { requireApproval: true, maxRisk: "high" } },
      },
      approval: createQueuedApprovalHandler(queue, { pollMs: 100, ttlMs: 5_000 }),
    };

    try {
      const agent = new SofiaAgent(deps);
      const running = agent.run({
        task: "Perform the protected write.",
        principalId: "owner-a",
        useBrain: false,
        maxSteps: 3,
      });
      const pending = await waitForPending(queue, "owner-a");
      assert.equal(executions, 0, "tool must not execute while approval is pending");
      const decision = queue.decide({
        id: pending.id,
        ownerId: "owner-a",
        decidedBy: "owner-a",
        actionHash: pending.actionHash,
        approved,
      });
      assert.equal(decision?.status, approved ? "approved" : "rejected");
      const result = await running;
      assert.match(result.output, /Finished after the approval decision/);
      assert.equal(executions, approved ? 1 : 0);
      assert.equal(modelCalls, 2);
    } finally {
      queue.close();
    }
  });
}
