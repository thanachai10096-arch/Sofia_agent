import type { CronScheduler, CronSchedule } from "./cron-scheduler.js";
import type { SofiaTool, ToolContext } from "../tools/types.js";

type ScheduleCreator = Pick<CronScheduler, "create">;

type ParsedWhen = { cron: string } | { runAt: string };

export function parseNaturalSchedule(when: string, now = new Date()): ParsedWhen {
  const value = when.trim().toLowerCase().replace(/\s+/g, " ");
  const relative = value.match(/^in (\d{1,4}) (minute|minutes|hour|hours|day|days)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!;
    const multiplier = unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000;
    const maximum = unit.startsWith("minute") ? 10_080 : unit.startsWith("hour") ? 8_760 : 365;
    if (amount < 1 || amount > maximum) throw new Error("Relative schedule is outside the supported range.");
    return { runAt: new Date(now.getTime() + amount * multiplier).toISOString() };
  }
  const recurring = value.match(/^every (day|morning|weekday|weekdays|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!recurring) throw new Error('Could not safely interpret "when". Try "every day at 8 am", "every weekday at 9:30 am", or "in 30 minutes".');
  const cadence = recurring[1]!;
  let hour = Number(recurring[2]);
  const minute = Number(recurring[3] ?? "0");
  const meridiem = recurring[4];
  if (minute > 59 || hour > 23 || hour < 0 || (meridiem && (hour < 1 || hour > 12))) throw new Error("Schedule time is invalid.");
  if (meridiem === "am") hour = hour === 12 ? 0 : hour;
  if (meridiem === "pm") hour = hour === 12 ? 12 : hour + 12;
  const days: Record<string, string> = { monday: "1", tuesday: "2", wednesday: "3", thursday: "4", friday: "5", saturday: "6", sunday: "0" };
  const dow = cadence === "weekday" || cadence === "weekdays" ? "1-5" : (days[cadence] ?? "*");
  return { cron: String(minute) + " " + String(hour) + " * * " + dow };
}


/** Agent-facing schedule creation. Ownership is always derived from the authenticated principal. */
export function createCronTools(scheduler: ScheduleCreator): SofiaTool[] {
  const scheduleTask: SofiaTool = {
    name: "schedule_task",
    description: "Create a persistent one-time or recurring task. Requires approval because it schedules future work. The schedule belongs to the authenticated user; when the host has a verified messaging destination, Sofia delivers the result to that conversation.",
    effects: ["write"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short human-readable schedule name" },
        task: { type: "string", description: "Task Sofia should execute at the scheduled time" },
        cron: { type: "string", description: "Five-field cron expression for a recurring task; mutually exclusive with runAt and when" },
        runAt: { type: "string", description: "ISO-8601 timestamp for a one-time task; mutually exclusive with cron and when" },
        when: { type: "string", description: "Natural-language schedule: every day at 8 am, every weekday at 9:30 am, or in 30 minutes. Mutually exclusive with cron and runAt." },
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
      let cron = typeof input.cron === "string" ? input.cron.trim() : undefined;
      let runAt = typeof input.runAt === "string" ? input.runAt.trim() : undefined;
      const when = typeof input.when === "string" ? input.when.trim() : undefined;
      if (when) {
        if (cron !== undefined || runAt !== undefined) throw new Error("Provide only one of cron, runAt, or when.");
        const parsed = parseNaturalSchedule(when);
        if ("cron" in parsed) cron = parsed.cron;
        else runAt = parsed.runAt;
      } else if ((cron === undefined) === (runAt === undefined)) {
        throw new Error("Provide exactly one of cron, runAt, or when.");
      }
      const timeZone = typeof input.timeZone === "string" && input.timeZone.trim()
        ? input.timeZone.trim()
        : (process.env.SOFIA_DEFAULT_TIME_ZONE?.trim() || "UTC");
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
        ...(context.notificationTarget ? { notificationTarget: context.notificationTarget } : {}),
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
        ...(when ? { interpretedWhen: when } : {}),
        note: context.notificationTarget
          ? "Result delivery is bound to the verified originating conversation."
          : "No verified messaging destination was attached; the result remains available in durable job history.",
        ...(!input.timeZone && !process.env.SOFIA_DEFAULT_TIME_ZONE ? { timeZoneNote: "No timezone was supplied; UTC was used. Set SOFIA_DEFAULT_TIME_ZONE or specify timeZone to use a local timezone." } : {}),
      };
    },
  };
  return [scheduleTask];
}
