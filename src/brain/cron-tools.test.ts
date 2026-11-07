import assert from "node:assert/strict";
import test from "node:test";
import { createCronManagementTools } from "./cron-tools.js";
import type { CronScheduler } from "./cron-scheduler.js";

test("cron tools bind reads and writes to the authenticated actor", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const scheduler = {
    async list(actor: string) { calls.push({ method: "list", args: [actor] }); return []; },
    async schedulerStatus(actor: string) { calls.push({ method: "status", args: [actor] }); return { paused: false, enabledSchedules: 0, activeExecutions: 0 }; },
    async pauseAll(actor: string, reason?: string) { calls.push({ method: "pause", args: [actor, reason] }); return { paused: true }; },
    async resumeAll(actor: string) { calls.push({ method: "resume", args: [actor] }); return { paused: false }; },
    async create(input: unknown, actor: string) { calls.push({ method: "create", args: [input, actor] }); return { id: "schedule-1" }; },
    async setEnabled(id: string, enabled: boolean, actor: string) { calls.push({ method: "setEnabled", args: [id, enabled, actor] }); return { id, status: enabled ? "enabled" : "disabled" }; },
    async cancel(id: string, actor: string) { calls.push({ method: "cancel", args: [id, actor] }); return true; },
    async history(id: string, actor: string) { calls.push({ method: "history", args: [id, actor] }); return []; },
  } as unknown as CronScheduler;
  const [readTool, writeTool] = createCronManagementTools(scheduler, "authenticated-principal");
  const context = { runtime: {} as never };

  await readTool.execute({ action: "list" }, context);
  await writeTool.execute({ action: "pause", reason: "maintenance" }, context);
  assert.deepEqual(calls, [
    { method: "list", args: ["authenticated-principal"] },
    { method: "pause", args: ["authenticated-principal", "maintenance"] },
  ]);
  assert.deepEqual(readTool.effects, ["read"]);
  assert.deepEqual(writeTool.effects, ["write"]);
  assert.equal((readTool.inputSchema.properties as Record<string, unknown>).ownerKeyId, undefined);
  assert.equal((writeTool.inputSchema.properties as Record<string, unknown>).ownerKeyId, undefined);
  assert.equal(readTool.inputSchema.additionalProperties, false);
  assert.equal(writeTool.inputSchema.additionalProperties, false);
});

test("cron management tool creates owner-scoped schedules with the host principal", async () => {
  let captured: unknown;
  let actor: string | undefined;
  const scheduler = {
    async create(input: unknown, authenticatedActor: string) {
      captured = input;
      actor = authenticatedActor;
      return { id: "schedule-1" };
    },
  } as unknown as CronScheduler;
  const [, writeTool] = createCronManagementTools(scheduler, "owner-123");
  await writeTool.execute({
    action: "create",
    name: "daily",
    task: "summarize updates",
    cron: "0 8 * * *",
    timeZone: "Asia/Bangkok",
  }, { runtime: {} as never });
  assert.equal(actor, "owner-123");
  assert.deepEqual(captured, {
    name: "daily",
    task: "summarize updates",
    timeZone: "Asia/Bangkok",
    ownerKeyId: "owner-123",
    cron: "0 8 * * *",
  });
});
