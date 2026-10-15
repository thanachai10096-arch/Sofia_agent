import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
