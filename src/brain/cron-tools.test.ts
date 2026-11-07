import assert from "node:assert/strict";
import test from "node:test";
import { createCronManagementTools } from "./cron-tools.js";
import type { CronScheduler } from "./cron-scheduler.js";

test("cron management tool always uses the authenticated actor, never a model-supplied owner", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const scheduler = {
    async list(actor: string) { calls.push({ method: "list", args: [actor] }); return []; },
    async schedulerStatus(actor: string) { calls.push({ method: "status", args: [actor] }); return { paused: false, enabledSchedules: 0, activeExecutions: 0 }; },
    async pauseAll(actor: string, reason?: string) { calls.push({ method: "pause", args: [actor, reason] }); return { paused: true, pausedAt: "2026-11-07T00:00:00.000Z", reason: reason ?? "Paused by operator" }; },
    async resumeAll(actor: string) { calls.push({ method: "resume", args: [actor] }); return { paused: false, resumedAt: "2026-11-07T00:00:00.000Z" }; },
    async create(input: unknown, actor: string) { calls.push({ method: "create", args: [input, actor] }); return { id: "schedule-1" }; },
    async setEnabled(id: string, enabled: boolean, actor: string) { calls.push({ method: "setEnabled", args: [id, enabled, actor] }); return { id, status: enabled ? "enabled" : "disabled" }; },
    async cancel(id: string, actor: string) { calls.push({ method: "cancel", args: [id, actor] }); return true; },
    async history(id: string, actor: string) { calls.push({ method: "history", args: [id, actor] }); return []; },
  } as unknown as CronScheduler;
  const tool = createCronManagementTools(scheduler, "authenticated-principal")[0]!;
  const execute = (input: Record<string, unknown>) => tool.execute(input, { runtime: {} as never });

  await execute({ action: "list" });
  await execute({ action: "pause", reason: "maintenance" });
  await execute({ action: "create", name: "daily", task: "summarize updates", cron: "0 8 * * *", timeZone: "Asia/Bangkok", ownerKeyId: "attacker" } as Record<string, unknown>).catch(() => undefined);
  assert.deepEqual(calls.slice(0, 2), [
    { method: "list", args: ["authenticated-principal"] },
    { method: "pause", args: ["authenticated-principal", "maintenance"] },
  ]);
  assert.equal(calls.some((call) => call.method === "create"), false);
  assert.throws(() => {
    const schema = tool.inputSchema;
    const properties = schema.properties as Record<string, unknown>;
    assert.equal(properties.ownerKeyId, undefined);
  });
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
  const tool = createCronManagementTools(scheduler, "owner-123")[0]!;
  await tool.execute({
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
