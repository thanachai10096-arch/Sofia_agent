import assert from "node:assert/strict";
import test from "node:test";
import type { ToolGateway, ToolCall, ToolExecutionContext, ToolResult, WorkspaceCheckpoint, WorkspaceSnapshot } from "./types.js";
import { createWorkflowPlan } from "./workflow-plan.js";
import { FileWorkflowPlanStore } from "./workflow-plan-store.js";
import { WorkflowOrchestrator } from "./workflow-orchestrator.js";
import { createToolGatewayWorkflowAdapter } from "./workflow-tool-adapter.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function fakeGateway(effects: readonly ("read" | "write" | "shell" | "network" | "browser" | "destructive")[], observed: { call?: ToolCall; context?: ToolExecutionContext }): ToolGateway {
  return {
    listTools: () => [{ name: "workspace.write_file", description: "Write a file", effects }],
    describe: (name) => name === "workspace.write_file" ? { effects } : undefined,
    execute: async (call, context): Promise<ToolResult> => {
      observed.call = call;
      observed.context = context;
      return { ok: true, data: { written: true }, evidenceId: "evidence-written" };
    },
    snapshot: async (): Promise<WorkspaceSnapshot> => ({ id: "snapshot-1", revision: "rev-1", evidenceId: "evidence-snapshot" }),
    changedFiles: async () => [],
    checkpoint: async (): Promise<WorkspaceCheckpoint> => ({ id: "checkpoint-real", revision: "rev-1" }),
    rollback: async () => [],
  };
}

test("ToolGateway adapter routes actions through gateway with principal and approval gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-adapter-"));
  try {
    const observed: { call?: ToolCall; context?: ToolExecutionContext } = {};
    const gateway = fakeGateway(["write"], observed);
    const adapter = createToolGatewayWorkflowAdapter({
      gateway,
      principalId: "principal-test",
      requestApproval: async () => true,
    });
    const store = new FileWorkflowPlanStore("adapter-success", root);
    const orchestrator = new WorkflowOrchestrator({ store, ...adapter });
    await orchestrator.create(createWorkflowPlan("write file", [{
      id: "write",
      title: "Write",
      description: "Write a file",
      idempotent: true,
      consequential: true,
      action: { tool: "workspace.write_file", input: { path: "safe.txt", content: "hello" } },
    }], { id: "adapter-success" }));
    const result = await orchestrator.run("adapter-success");
    assert.equal(result.plan.status, "completed");
    assert.equal(observed.call?.tool, "workspace.write_file");
    assert.equal(observed.context?.principalId, "principal-test");
    assert.equal(observed.context?.requireApproval, true);
    assert.deepEqual(result.plan.steps[0]?.evidenceIds, ["evidence-written"]);
    assert.equal(result.plan.steps[0]?.checkpointId, "checkpoint-real");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ToolGateway adapter blocks a mutating action that is not declared consequential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-adapter-"));
  try {
    const observed: { call?: ToolCall; context?: ToolExecutionContext } = {};
    const gateway = fakeGateway(["write"], observed);
    const adapter = createToolGatewayWorkflowAdapter({ gateway, requestApproval: async () => true });
    const store = new FileWorkflowPlanStore("adapter-block", root);
    const orchestrator = new WorkflowOrchestrator({ store, ...adapter });
    await orchestrator.create(createWorkflowPlan("unsafe", [{
      id: "write",
      title: "Write",
      description: "Write without a safety gate",
      idempotent: true,
      action: { tool: "workspace.write_file", input: { path: "safe.txt", content: "hello" } },
    }], { id: "adapter-block" }));
    const result = await orchestrator.run("adapter-block");
    assert.equal(result.plan.status, "failed");
    assert.equal(observed.call, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ToolGateway adapter blocks unknown tools before invocation", async () => {
  const observed: { call?: ToolCall; context?: ToolExecutionContext } = {};
  const gateway = fakeGateway(["read"], observed);
  const adapter = createToolGatewayWorkflowAdapter({ gateway });
  await assert.rejects(() => adapter.executeStep({
    id: "missing", title: "Missing", description: "Missing tool", idempotent: true,
    dependsOn: [], status: "running", attempts: 1, evidenceIds: [], updatedAt: new Date().toISOString(),
    action: { tool: "unknown.tool", input: {} },
  }, { workflowId: "workflow" }), /Unknown or unavailable tool/);
  assert.equal(observed.call, undefined);
});
