import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createCronTools } from "./cron-tools.js";
import type { CronSchedule, CronScheduleInput, CronScheduler } from "./cron-scheduler.js";

test("schedule_task binds ownership to the authenticated principal", async () => {
  let captured: { input: CronScheduleInput; actor: string } | undefined;
  const scheduler: Pick<CronScheduler, "create"> = {
    async create(input, actor): Promise<CronSchedule> {
      captured = { input, actor };
      return {
        ...input,
        id: "schedule-1",
        status: "enabled" as const,
        createdAt: "2026-10-28T00:00:00.000Z",
        updatedAt: "2026-10-28T00:00:00.000Z",
        nextRunAt: "2026-10-28T01:00:00.000Z",
        consecutiveFailures: 0,
      };
    },
  };
  const tool = createCronTools(scheduler).find((item) => item.name === "schedule_task")!;

  const result = await tool.execute(
    { name: "Daily check", task: "Check project status", cron: "0 9 * * *", timeZone: "Asia/Bangkok" },
    { runtime: {} as never, principalId: "user-key-1", notificationTarget: { platform: "discord", userId: "discord-user-7", conversationId: "discord-channel-4" } },
  ) as { created: boolean; id: string };

  assert.equal(result.created, true);
  assert.equal(result.id, "schedule-1");
  assert.equal(captured?.actor, "user-key-1");
  assert.equal(captured?.input.ownerKeyId, "user-key-1");
  assert.equal(captured?.input.timeZone, "Asia/Bangkok");
  assert.deepEqual(captured?.input.notificationTarget, { platform: "discord", userId: "discord-user-7", conversationId: "discord-channel-4" });
});

test("schedule_task rejects missing authenticated principal", async () => {
  const scheduler: Pick<CronScheduler, "create"> = { async create() { throw new Error("should not be called"); } };
  const tool = createCronTools(scheduler)
    .find((item) => item.name === "schedule_task")!;
  await assert.rejects(
    tool.execute({ name: "Once", task: "Do task", runAt: "2026-10-28T01:00:00Z" }, { runtime: {} as never }),
    /authenticated principal/,
  );
});

test("schedule_task requires exactly one of cron and runAt", async () => {
  const scheduler: Pick<CronScheduler, "create"> = { async create() { throw new Error("should not be called"); } };
  const tool = createCronTools(scheduler).find((item) => item.name === "schedule_task")!;
  await assert.rejects(
    tool.execute({ name: "Invalid", task: "Do task" }, { runtime: {} as never, principalId: "user-key-1" }),
    /exactly one of cron or runAt/,
  );
});
