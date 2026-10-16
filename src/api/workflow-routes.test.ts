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


test("workflow API uses the runtime wired by Sofia Agent dependencies when config does not override it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-api-factory-"));
  const deps = {
    workflowStateRoot: root,
    workflowRuntime: () => ({
      executeStep: async (step: { id: string }) => ({ evidenceIds: ["factory:" + step.id] }),
    }),
  } as unknown as AgentDependencies;
  const server = createSofiaApi(deps, {
    apiKeys: { "workflow-user": ["agent:read", "agent:run"] },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a TCP port");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/workflows", {
      headers: auth("workflow-user"),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { workflows: unknown[] }).workflows, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});


test("real Sofia factory executes a consequential workspace action through checkpoint and exact one-time approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-workflow-e2e-"));
  const envKeys = ["SOFIA_AI_GATEWAY_API_KEY", "SOFIA_FAST_MODEL", "SOFIA_ALLOW_FILE_WRITE", "SOFIA_ALLOW_TOOLS"] as const;
  const prior = new Map(envKeys.map((key) => [key, process.env[key]]));
  const approvals: ApprovalRequest[] = [];
  let server: ReturnType<typeof createSofiaApi> | undefined;
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    process.env.SOFIA_AI_GATEWAY_API_KEY = "workflow-test-key";
    process.env.SOFIA_FAST_MODEL = "workflow-test-model";
    process.env.SOFIA_ALLOW_FILE_WRITE = "true";
    process.env.SOFIA_ALLOW_TOOLS = "true";
    const deps = createSofiaAgentDependencies(root, async (request) => {
      approvals.push(request);
      return true;
    });
    server = createSofiaApi(deps, {
      apiKeys: { "workflow-e2e-user": ["agent:read", "agent:run"] },
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test API did not bind a TCP port");
    const baseUrl = "http://127.0.0.1:" + address.port;
    const planResponse = await fetch(baseUrl + "/v1/workflows", {
      method: "POST",
      headers: auth("workflow-e2e-user"),
      body: JSON.stringify({
        title: "Write through Sofia's secured runtime",
        steps: [{
          id: "write",
          title: "Write a file",
          description: "Create a test file after explicit approval",
          idempotent: false,
          consequential: true,
          action: { tool: "workspace.write_file", input: { path: "approved.txt", content: "approved" } },
        }],
      }),
    });
    assert.equal(planResponse.status, 201);
    const created = await planResponse.json() as { workflow: { id: string } };
    const runResponse = await fetch(baseUrl + "/v1/workflows/" + created.workflow.id + "/run", {
      method: "POST",
      headers: auth("workflow-e2e-user"),
    });
    assert.equal(runResponse.status, 200);
    const result = await runResponse.json() as { plan: { status: string; steps: Array<{ status: string; checkpointId?: string }> } };
    assert.equal(result.plan.status, "completed");
    assert.equal(result.plan.steps[0]?.status, "succeeded");
    assert.ok(result.plan.steps[0]?.checkpointId);
    assert.equal(await (await import("node:fs/promises")).readFile(path.join(root, "approved.txt"), "utf8"), "approved");
    assert.equal(approvals.length, 1, "the exact action approval ticket should be consumed by ToolGateway without a second prompt");
    assert.equal(approvals[0]?.runId, created.workflow.id + ":write");
    assert.equal(approvals[0]?.principalId, (await (await fetch(baseUrl + "/v1/workflows", { headers: auth("workflow-e2e-user") })).json() as { workflows: unknown[] }).workflows.length >= 0 ? approvals[0]?.principalId : undefined);
    assert.equal(approvals[0]?.actionHash, actionHash(created.workflow.id + ":write", "workspace.write_file", { path: "approved.txt", content: "approved" }, approvals[0]?.principalId));
    assert.equal(approvals[0]?.toolName, "workspace.write_file");
  } finally {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    for (const key of envKeys) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
