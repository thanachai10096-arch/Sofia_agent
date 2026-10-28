import type { CronScheduler, CronSchedule } from "./cron-scheduler.js";
import type { SofiaTool, ToolContext } from "../tools/types.js";

type ScheduleCreator = Pick<CronScheduler, "create">;

/** Agent-facing schedule creation. Ownership is always derived from the authenticated principal. */
export function createCronTools(scheduler: ScheduleCreator): SofiaTool[] {
  const scheduleTask: SofiaTool = {
    name: "schedule_task",
    description: "Create a persistent one-time or recurring task. Requires approval because it schedules future work. The schedule belongs to the authenticated user; results currently remain in Sofia's durable job history and are not automatically delivered to a chat channel.",
    effects: ["write"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short human-readable schedule name" },
        task: { type: "string", description: "Task Sofia should execute at the scheduled time" },
        cron: { type: "string", description: "Five-field cron expression for a recurring task; mutually exclusive with runAt" },
        runAt: { type: "string", description: "ISO-8601 timestamp including timezone for a one-time task; mutually exclusive with cron" },
        timeZone: { type: "string", description: "IANA time zone for cron evaluation, such as Asia/Bangkok; defaults to UTC" },
        enabled: { type: "boolean", description: "Whether the schedule starts enabled; defaults to true" },
        misfirePolicy: { type: "string", enum: ["skip", "run-once"], description: "How to handle a missed run" },
        maxRetries: { type: "integer", description: "Retry count from 0 to 10" },
        timeoutMs: { type: "integer", description: "Execution timeout in milliseconds from 1000 to 3600000" },
      },
      required: ["name", "task"],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>, context: ToolContext) {
      const ownerKeyId = context.principalId?.trim();
      if (!ownerKeyId) throw new Error("Creating a schedule requires an authenticated principal.");
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (!name || name.length > 120) throw new Error("Schedule name must be between 1 and 120 characters.");
      if (!task || task.length > 8_000) throw new Error("Scheduled task must be between 1 and 8000 characters.");
      const cron = typeof input.cron === "string" ? input.cron.trim() : undefined;
      const runAt = typeof input.runAt === "string" ? input.runAt.trim() : undefined;
      if ((cron === undefined) === (runAt === undefined)) throw new Error("Provide exactly one of cron or runAt.");
      const timeZone = typeof input.timeZone === "string" && input.timeZone.trim() ? input.timeZone.trim() : "UTC";
      const maxRetries = input.maxRetries === undefined ? 0 : Number(input.maxRetries);
      const timeoutMs = input.timeoutMs === undefined ? 120_000 : Number(input.timeoutMs);
      if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error("maxRetries must be an integer from 0 to 10.");
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) throw new Error("timeoutMs must be an integer from 1000 to 3600000.");
      const misfirePolicy = input.misfirePolicy === undefined ? "skip" : input.misfirePolicy;
      if (misfirePolicy !== "skip" && misfirePolicy !== "run-once") throw new Error("misfirePolicy must be skip or run-once.");
      const created: CronSchedule = await scheduler.create({
        name,
        task,
        timeZone,
        ownerKeyId,
        ...(cron !== undefined ? { cron } : {}),
        ...(runAt !== undefined ? { runAt } : {}),
        ...(input.enabled === false ? { enabled: false } : {}),
        misfirePolicy,
        maxRetries,
        timeoutMs,
      }, ownerKeyId);
      return {
        created: true,
        id: created.id,
        name: created.name,
        status: created.status,
        nextRunAt: created.nextRunAt,
        timeZone: created.timeZone,
        ...(created.cron ? { cron: created.cron } : {}),
        ...(created.runAt ? { runAt: created.runAt } : {}),
        note: "Scheduled work is stored durably. Automatic Telegram/Discord delivery of the result is not configured yet.",
      };
    },
  };
  return [scheduleTask];
}
