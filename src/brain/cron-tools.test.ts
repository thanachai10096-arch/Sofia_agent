import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createCronTools, parseNaturalSchedule } from "./cron-tools.js";
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


test("natural-language schedule parser handles daily, weekday, and relative schedules", () => {
  assert.deepEqual(parseNaturalSchedule("every day at 8 am"), { cron: "0 8 * * *" });
  assert.deepEqual(parseNaturalSchedule("every weekday at 9:30 am"), { cron: "30 9 * * 1-5" });
  assert.deepEqual(parseNaturalSchedule("every monday 8 pm"), { cron: "0 20 * * 1" });
  assert.deepEqual(parseNaturalSchedule("in 30 minutes", new Date("2026-10-28T00:00:00.000Z")), {
    runAt: "2026-10-28T00:30:00.000Z",
  });
  assert.throws(() => parseNaturalSchedule("every once in a while"), /Could not safely interpret/);
  assert.throws(() => parseNaturalSchedule("every day at 25"), /Schedule time is invalid/);
});

test("schedule_task translates a natural-language when into a durable cron schedule", async () => {
  let captured: CronScheduleInput | undefined;
  const scheduler: Pick<CronScheduler, "create"> = {
    async create(input): Promise<CronSchedule> {
      captured = input;
      return {
        ...input, id: "natural-schedule", status: "enabled",
        createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z",
        nextRunAt: "2026-10-28T01:00:00.000Z", consecutiveFailures: 0,
      };
    },
  };
  const tool = createCronTools(scheduler).find((item) => item.name === "schedule_task")!;
  const result = await tool.execute({
    name: "Morning news", task: "Summarize news and send it to the originating chat",
    when: "every day at 8 am", timeZone: "Asia/Bangkok",
  }, {
    runtime: {} as never, principalId: "telegram:user-1",
    notificationTarget: { platform: "telegram", userId: "user-1", conversationId: "chat-1" },
  }) as { created: boolean; cron?: string; interpretedWhen?: string };
  assert.equal(result.created, true);
  assert.equal(result.cron, "0 8 * * *");
  assert.equal(result.interpretedWhen, "every day at 8 am");
  assert.equal(captured?.cron, "0 8 * * *");
  assert.equal(captured?.timeZone, "Asia/Bangkok");
  assert.equal(captured?.notificationTarget?.conversationId, "chat-1");
});
