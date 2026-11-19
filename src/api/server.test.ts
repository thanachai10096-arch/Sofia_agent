import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import { ApprovalBroker } from "../agent/approval.js";
import { MemorySessionStore } from "../session/store.js";
import { ModelRouter } from "../models/router.js";
import type { ModelRoute } from "../models/types.js";

const route: ModelRoute = {
  id: "api-session-test",
  capabilities: ["fast"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 1,
  healthy: true,
};

test("API sessions are persisted and scoped to the authenticated API key", async () => {
  const sessions = new MemorySessionStore();
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  }, {
    apiKeys: {
      "key-one": ["agent:run", "agent:read"],
      "key-two": ["agent:run", "agent:read"],
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const startAndWait = async (apiKey: string, task: string) => {
    const started = await fetch(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ task, sessionId: "shared-client-session", async: true }),
    });
    assert.equal(started.status, 202);
    const initial = await started.json() as { id: string };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${baseUrl}/v1/agent/runs/${initial.id}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(response.status, 200);
      const run = await response.json() as { status: string };
      if (run.status === "completed") return;
      if (run.status === "failed" || run.status === "cancelled") {
        throw new Error(`API run ended with status ${run.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("API run did not finish within the test deadline");
  };

  try {
    await startAndWait("key-one", "first user's task");
    await startAndWait("key-two", "second user's task");

    const idFor = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
    assert.deepEqual(sessions.get(`${idFor("key-one")}:shared-client-session`)?.messages, [
      "user: first user's task",
      "assistant: Task completed.",
    ]);
    assert.deepEqual(sessions.get(`${idFor("key-two")}:shared-client-session`)?.messages, [
      "user: second user's task",
      "assistant: Task completed.",
    ]);
    assert.equal(sessions.get("shared-client-session"), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("API lists configured models and honors an explicit model route", async () => {
  const routes: ModelRoute[] = [
    { id: "fast", model: "vendor/fast-model", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 5, healthy: true },
    { id: "coding", model: "vendor/coding-model", capabilities: ["coding", "tool-use", "reasoning"], costWeight: 2, latencyWeight: 2, qualityWeight: 8, healthy: true },
  ];
  const router = new ModelRouter(routes);
  const selected: string[] = [];
  const server = createSofiaApi({
    provider: {
      generate: async (_request, route) => {
        selected.push(route.id);
        return { text: "Task completed." };
      },
    },
    router,
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  }, {
    apiKeys: { "model-key": ["agent:run", "agent:read"] },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  try {
    const listed = await fetch(baseUrl + "/v1/models", {
      headers: { authorization: "Bearer model-key" },
    });
    assert.equal(listed.status, 200);
    const payload = await listed.json() as { automaticSelection: boolean; models: Array<{ id: string; model: string }> };
    assert.equal(payload.automaticSelection, true);
    assert.deepEqual(payload.models.map((model) => ({ id: model.id, model: model.model })), [
      { id: "fast", model: "vendor/fast-model" },
      { id: "coding", model: "vendor/coding-model" },
    ]);

    const response = await fetch(baseUrl + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer model-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "do a general task", modelRouteId: "coding" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(selected, ["coding"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("API rejects unknown model routes before starting a run", async () => {
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Should not run." }) },
    router: new ModelRouter([route]),
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, { apiKeys: { "model-key": ["agent:run"] } });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer model-key", "content-type": "application/json" },
      body: JSON.stringify({ task: "do a task", modelRouteId: "not-configured" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_model_route" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("approval API scopes pending requests and one-time decisions to the authenticated API key", async () => {
  const broker = new ApprovalBroker();
  const ownerId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
  const approvalResult = broker.handle({
    runId: "approval-run",
    principalId: ownerId("owner-key"),
    toolName: "workspace.write_file",
    input: { path: "notes.txt", content: "hello" },
    actionHash: "action-hash-1",
    risk: "high",
  });
  const [pending] = broker.pending(ownerId("owner-key"));
  assert.ok(pending);
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: {
      "owner-key": ["approval:read", "approval:decide"],
      "other-key": ["approval:read", "approval:decide"],
      "read-only-key": ["approval:read"],
    },
    approvalBroker: broker,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const auth = (key: string) => ({ authorization: "Bearer " + key, "content-type": "application/json" });
  try {
    const ownerList = await fetch(baseUrl + "/v1/approvals", { headers: auth("owner-key") });
    assert.equal(ownerList.status, 200);
    const listed = await ownerList.json() as { approvals: Array<{ id: string; actionHash: string }> };
    assert.equal(listed.approvals.length, 1);
    assert.equal(listed.approvals[0]?.actionHash, "action-hash-1");

    const otherList = await fetch(baseUrl + "/v1/approvals", { headers: auth("other-key") });
    assert.deepEqual(await otherList.json(), { approvals: [] });

    const wrongOwner = await fetch(baseUrl + "/v1/approvals/" + pending.id + "/decision", {
      method: "POST", headers: auth("other-key"),
      body: JSON.stringify({ actionHash: "action-hash-1", approved: true }),
    });
    assert.equal(wrongOwner.status, 404);

    const wrongHash = await fetch(baseUrl + "/v1/approvals/" + pending.id + "/decision", {
      method: "POST", headers: auth("owner-key"),
      body: JSON.stringify({ actionHash: "different-hash", approved: true }),
    });
    assert.equal(wrongHash.status, 404);

    const noDecisionScope = await fetch(baseUrl + "/v1/approvals/" + pending.id + "/decision", {
      method: "POST", headers: auth("read-only-key"),
      body: JSON.stringify({ actionHash: "action-hash-1", approved: true }),
    });
    assert.equal(noDecisionScope.status, 403);

    const accepted = await fetch(baseUrl + "/v1/approvals/" + pending.id + "/decision", {
      method: "POST", headers: auth("owner-key"),
      body: JSON.stringify({ actionHash: "action-hash-1", approved: true }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { approvalId: pending.id, status: "approved" });
    assert.equal(await approvalResult, true);

    const replay = await fetch(baseUrl + "/v1/approvals/" + pending.id + "/decision", {
      method: "POST", headers: auth("owner-key"),
      body: JSON.stringify({ actionHash: "action-hash-1", approved: true }),
    });
    assert.equal(replay.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("approval history is durable, owner-scoped, and requires approval:read", async () => {
  const root=await (await import("node:fs/promises")).mkdtemp((await import("node:os")).tmpdir()+"/sofia-api-approval-history-");
  const file=(await import("node:path")).join(root,"approvals.json");
  const broker=new ApprovalBroker(120_000,new (await import("../agent/approval.js")).FileApprovalJournal(file));
  const pendingResult=broker.handle({
    runId:"history-run",principalId:createHash("sha256").update("owner-key").digest("hex").slice(0,32),
    toolName:"workspace.write_file",input:{path:"x",content:"secret"},actionHash:"history-hash",risk:"high",
  });
  const [pending]=broker.pending(createHash("sha256").update("owner-key").digest("hex").slice(0,32));
  assert.ok(pending);
  broker.decide({approvalId:pending.id,principalId:createHash("sha256").update("owner-key").digest("hex").slice(0,32),actionHash:"history-hash",approved:false});
  assert.equal(await pendingResult,false);
  const server=createSofiaApi({
    provider:{generate:async()=>({text:"unused"})},router:{select:()=>route,markUnhealthy:()=>undefined},
    reviewer:{review:async()=>({approved:true,reason:"unused"})},
  },{
    apiKeys:{"owner-key":["approval:read"],"other-key":["approval:read"],"no-history-key":[]},
    approvalBroker:broker,
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); assert.ok(address&&typeof address!=="string");
  const base="http://127.0.0.1:"+address.port;
  try {
    const owner=await fetch(base+"/v1/approvals/history",{headers:{authorization:"Bearer owner-key"}});
    assert.equal(owner.status,200);
    const payload=await owner.json() as {approvals:Array<{status:string;principalId:string}>};
    assert.equal(payload.approvals[0]?.status,"rejected");
    assert.equal(payload.approvals[0]?.principalId,createHash("sha256").update("owner-key").digest("hex").slice(0,32));
    const other=await fetch(base+"/v1/approvals/history",{headers:{authorization:"Bearer other-key"}});
    assert.deepEqual(await other.json(),{approvals:[]});
    const denied=await fetch(base+"/v1/approvals/history",{headers:{authorization:"Bearer no-history-key"}});
    assert.equal(denied.status,403);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await (await import("node:fs/promises")).rm(root,{recursive:true,force:true});
  }
});
