import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createSofiaAgentDependencies } from "../models/factory.js";
import { actionHash } from "../security/guard.js";
import type { ApprovalRequest } from "../agent/approval.js";
import type { AgentDependencies } from "../agent/types.js";
import { createSofiaApi } from "./server.js";

async function withApi<T>(run: (baseUrl: string, principalIds: string[]) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-api-"));
  const principalIds: string[] = [];
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: {
      "workflow-user-a": ["agent:read", "agent:run"],
      "workflow-user-b": ["agent:read", "agent:run"],
      "workflow-read-only": ["agent:read"],
    },
    workflowStateRoot: root,
    workflowRuntime: (principalId) => {
      principalIds.push(principalId);
      return {
        executeStep: async (step) => ({ evidenceIds: ["api-test:" + step.id] }),
        createCheckpoint: async () => ({ id: "checkpoint-test", verified: true }),
        requestApproval: async () => true,
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a TCP port");
  try {
    return await run("http://127.0.0.1:" + address.port, principalIds);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

function auth(token: string): HeadersInit {
  return { authorization: "Bearer " + token, "content-type": "application/json" };
}

test("workflow API creates, lists, runs, and isolates plans by authenticated principal", async () => {
  await withApi(async (baseUrl, principalIds) => {
    const create = await fetch(baseUrl + "/v1/workflows", {
      method: "POST",
      headers: auth("workflow-user-a"),
      body: JSON.stringify({
        title: "API workflow",
        steps: [{ id: "inspect", title: "Inspect", description: "Read-only test action", idempotent: true }],
      }),
    });
    assert.equal(create.status, 201);
    const created = await create.json() as { workflow: { id: string; status: string } };
    assert.equal(created.workflow.status, "draft");

    const invalid = await fetch(baseUrl + "/v1/workflows", {
      method: "POST",
      headers: auth("workflow-user-a"),
      body: JSON.stringify({ title: "Bad workflow", steps: [{ id: "dup", title: "One", description: "First", idempotent: true }, { id: "dup", title: "Two", description: "Duplicate ID", idempotent: true }] }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: string }).error, "invalid_workflow");

    const list = await fetch(baseUrl + "/v1/workflows", { headers: auth("workflow-user-a") });
    assert.equal(list.status, 200);
    assert.equal((await list.json() as { workflows: unknown[] }).workflows.length, 1);

    const foreignList = await fetch(baseUrl + "/v1/workflows", { headers: auth("workflow-user-b") });
    assert.equal((await foreignList.json() as { workflows: unknown[] }).workflows.length, 0);

    const foreignRead = await fetch(baseUrl + "/v1/workflows/" + created.workflow.id, {
      headers: auth("workflow-user-b"),
    });
    assert.equal(foreignRead.status, 404);
    assert.ok(principalIds.length > 0);
    assert.ok(principalIds.every((id) => /^[a-f0-9]{32}$/.test(id)));

    const run = await fetch(baseUrl + "/v1/workflows/" + created.workflow.id + "/run", {
      method: "POST",
      headers: auth("workflow-user-a"),
    });
    assert.equal(run.status, 200);
    const result = await run.json() as { plan: { status: string; steps: Array<{ status: string; evidenceIds: string[] }> } };
    assert.equal(result.plan.status, "completed");
    assert.equal(result.plan.steps[0]?.status, "succeeded");
    assert.deepEqual(result.plan.steps[0]?.evidenceIds, ["api-test:inspect"]);

    const forbiddenCreate = await fetch(baseUrl + "/v1/workflows", {
      method: "POST",
      headers: auth("workflow-read-only"),
      body: JSON.stringify({ title: "No write", steps: [{ id: "s", title: "S", description: "No", idempotent: true }] }),
    });
    assert.equal(forbiddenCreate.status, 403);
  });
});

test("workflow API fails closed when the host has not configured workflow execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-api-disabled-"));
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { "workflow-user": ["agent:read", "agent:run"] },
    workflowStateRoot: root,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a TCP port");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/workflows", {
      headers: auth("workflow-user"),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: string }).error, "workflow_runtime_unavailable");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});


test("factory-wired workflow API isolates the same principal across different workspaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-api-factory-"));
  const makeDeps = (namespace: string) => ({
    workflowStateRoot: root,
    workflowNamespace: namespace,
    workflowRuntime: () => ({
      executeStep: async (step: { id: string }) => ({ evidenceIds: ["factory:" + step.id] }),
    }),
  }) as unknown as AgentDependencies;
  const serverA = createSofiaApi(makeDeps("workspace-a"), {
    apiKeys: { "workflow-user": ["agent:read", "agent:run"] },
  });
  let serverB: ReturnType<typeof createSofiaApi> | undefined;
  await new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", resolve));
  const addressA = serverA.address();
  if (!addressA || typeof addressA === "string") throw new Error("Test API did not bind a TCP port");
  try {
    const baseA = "http://127.0.0.1:" + addressA.port;
    const create = await fetch(baseA + "/v1/workflows", {
      method: "POST",
      headers: auth("workflow-user"),
      body: JSON.stringify({
        title: "Workspace A plan",
        steps: [{ id: "inspect", title: "Inspect", description: "Read-only", idempotent: true }],
      }),
    });
    assert.equal(create.status, 201);
    const listA = await fetch(baseA + "/v1/workflows", { headers: auth("workflow-user") });
    assert.equal((await listA.json() as { workflows: unknown[] }).workflows.length, 1);

    serverB = createSofiaApi(makeDeps("workspace-b"), {
      apiKeys: { "workflow-user": ["agent:read", "agent:run"] },
    });
    await new Promise<void>((resolve) => serverB!.listen(0, "127.0.0.1", resolve));
    const addressB = serverB.address();
    if (!addressB || typeof addressB === "string") throw new Error("Second test API did not bind a TCP port");
    const listB = await fetch("http://127.0.0.1:" + addressB.port + "/v1/workflows", {
      headers: auth("workflow-user"),
    });
    assert.equal((await listB.json() as { workflows: unknown[] }).workflows.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => serverA.close((error) => error ? reject(error) : resolve()));
    if (serverB?.listening) await new Promise<void>((resolve, reject) => serverB!.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
