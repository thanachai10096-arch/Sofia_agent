import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { createSofiaApi } from "./server.js";
import type { ContinuousWorkRecord, ContinuousWorkSupervisor } from "../brain/continuous-work.js";
import type { ModelRoute } from "../models/types.js";

const route: ModelRoute = {
  id: "continuous-work-api-test",
  capabilities: ["fast"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 1,
  healthy: true,
};

test("continuous-work API is owner-scoped and exposes create, resume, pause, and stop", async () => {
  const records = new Map<string, ContinuousWorkRecord>();
  const supervisor = {
    async create(ownerKeyId: string, task: string) {
      const now = new Date().toISOString();
      const record: ContinuousWorkRecord = {
        id: "work-" + (records.size + 1), ownerKeyId, task, status: "paused", iteration: 0,
        maxIterationsPerActivation: 2, createdAt: now, updatedAt: now,
      };
      records.set(record.id, record);
      return { ...record };
    },
    async get(id: string, owner: string) {
      const record = records.get(id);
      return record?.ownerKeyId === owner ? { ...record } : undefined;
    },
    async list(owner: string) {
      return [...records.values()].filter((record) => record.ownerKeyId === owner).map((record) => ({ ...record }));
    },
    async resume(id: string, owner: string) {
      const record = records.get(id);
      if (!record || record.ownerKeyId !== owner) throw new Error("not found");
      record.status = "active";
      return { ...record };
    },
    isContinuous() { return false; },
    async runContinuously(id: string, owner: string) {
      const record = records.get(id);
      if (!record || record.ownerKeyId !== owner || ["stopped", "completed", "failed"].includes(record.status)) return false;
      record.status = "active";
      return true;
    },
    async pause(id: string, owner: string) {
      const record = records.get(id);
      if (!record || record.ownerKeyId !== owner || record.status !== "active") return false;
      record.status = "paused";
      return true;
    },
    async stop(id: string, owner: string) {
      const record = records.get(id);
      if (!record || record.ownerKeyId !== owner || record.status === "stopped") return false;
      record.status = "stopped";
      return true;
    },
  } as unknown as ContinuousWorkSupervisor;

  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
  }, {
    apiKeys: {
      "owner-key": ["agent:run", "agent:read"],
      "other-key": ["agent:run", "agent:read"],
      "read-only-key": ["agent:read"],
    },
    continuousWorkSupervisor: supervisor,
    messagingContextSecret: "test-messaging-context-secret-at-least-32-chars",
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = (key: string, path: string, method = "GET", value?: unknown) => fetch(baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(value !== undefined ? { "content-type": "application/json" } : {}) },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });

  try {
    const created = await request("owner-key", "/v1/continuous-work", "POST", { task: "Keep improving the project in verifiable steps." });
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { work: ContinuousWorkRecord }).work.status, "paused");

    const hidden = await request("other-key", "/v1/continuous-work/work-1");
    assert.equal(hidden.status, 404);
    const forbidden = await request("read-only-key", "/v1/continuous-work", "POST", { task: "must not start" });
    assert.equal(forbidden.status, 403);

    const resumed = await request("owner-key", "/v1/continuous-work/work-1/resume", "POST");
    assert.equal(resumed.status, 202);
    const active = await request("owner-key", "/v1/continuous-work/work-1");
    assert.equal((await active.json() as { work: ContinuousWorkRecord }).work.status, "active");

    const paused = await request("owner-key", "/v1/continuous-work/work-1/pause", "POST");
    assert.equal(paused.status, 200);
    assert.equal((await paused.json() as { work: ContinuousWorkRecord }).work.status, "paused");

    const stopped = await request("owner-key", "/v1/continuous-work/work-1/stop", "POST");
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json() as { work: ContinuousWorkRecord }).work.status, "stopped");

    const second = await request("owner-key", "/v1/continuous-work", "POST", { task: "Keep running bounded slices until paused." });
    assert.equal(second.status, 201);
    const secondWork = (await second.json() as { work: ContinuousWorkRecord }).work;
    const continuous = await request("owner-key", `/v1/continuous-work/${secondWork.id}/continue`, "POST");
    assert.equal(continuous.status, 202);
    assert.equal((await continuous.json() as { mode: string }).mode, "continuous");
    const signedAction = async (userId: string, action: Record<string, unknown>, messageId: string) => {
      const signedTask = JSON.stringify(action);
      const unsigned = {
        platform: "telegram" as const,
        userId,
        conversationId: "chat-" + userId,
        messageId,
        taskHash: createHash("sha256").update(signedTask).digest("hex"),
      };
      const messagingContext = {
        ...unsigned,
        signature: createHmac("sha256", "test-messaging-context-secret-at-least-32-chars")
          .update(JSON.stringify(unsigned)).digest("hex"),
      };
      return request("owner-key", "/v1/continuous-work/chat", "POST", { signedTask, messagingContext });
    };
    const chatCreated = await signedAction("telegram-user-1", { action: "create", task: "Improve the project with evidence." }, "msg-1");
    assert.equal(chatCreated.status, 201);
    const chatWork = (await chatCreated.json() as { work: ContinuousWorkRecord }).work;
    assert.ok(chatWork.ownerKeyId.startsWith("chat:"));
    const chatList = await signedAction("telegram-user-1", { action: "list" }, "msg-2");
    assert.equal((await chatList.json() as { work: ContinuousWorkRecord[] }).work.length, 1);
    const isolatedList = await signedAction("telegram-user-2", { action: "list" }, "msg-3");
    assert.equal((await isolatedList.json() as { work: ContinuousWorkRecord[] }).work.length, 0);
    const invalidSignature = await request("owner-key", "/v1/continuous-work/chat", "POST", {
      signedTask: JSON.stringify({ action: "list" }),
      messagingContext: { platform: "telegram", userId: "telegram-user-1", conversationId: "chat-telegram-user-1", messageId: "msg-4", taskHash: "0".repeat(64), signature: "0".repeat(64) },
    });
    assert.equal(invalidSignature.status, 401);

  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
