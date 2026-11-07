import type { SofiaTool } from "../tools/types.js";
import type { CronScheduleInput, CronScheduler } from "./cron-scheduler.js";

const actionSchema = {
  type: "string",
  enum: ["list", "status", "pause", "resume", "create", "enable", "disable", "cancel", "history"],
};

/**
 * Expose the authenticated principal's cron controls to the Brain.
 * The actor is supplied by the trusted host, never accepted from model input.
 */
export function createCronManagementTools(
  scheduler: CronScheduler,
  actor: string,
): SofiaTool[] {
  if (!actor.trim()) return [];
  return [{
    name: "cronjob_manage",
    description: "Manage the authenticated user's scheduled jobs. Actions: list, status, pause, resume, create, enable, disable, cancel, history. Creating or changing schedules is an operational side effect; explain the intended schedule and obtain user confirmation before calling create, pause, resume, enable, disable, or cancel.",
    effects: ["read", "write"],
    inputSchema: {
      type: "object",
      properties: {
        action: actionSchema,
        id: { type: "string", description: "Exact schedule ID, required for enable, disable, cancel, and history." },
        name: { type: "string", description: "Human-readable schedule name, required for create." },
        task: { type: "string", description: "Task Sofia should execute on each occurrence, required for create." },
        cron: { type: "string", description: "Five-field cron expression for recurring schedules. Mutually exclusive with runAt." },
        runAt: { type: "string", description: "ISO-8601 timestamp including timezone for a one-time schedule. Mutually exclusive with cron." },
        timeZone: { type: "string", description: "IANA timezone such as Asia/Bangkok, required for create." },
        misfirePolicy: { type: "string", enum: ["skip", "run-once"] },
        maxRetries: { type: "integer" },
        timeoutMs: { type: "integer" },
        reason: { type: "string", description: "Reason for globally pausing the scheduler (maximum 500 characters)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input) {
      const action = String(input.action);
      const id = typeof input.id === "string" ? input.id : "";
      switch (action) {
        case "list":
          return { schedules: await scheduler.list(actor) };
        case "status":
          return await scheduler.schedulerStatus(actor);
        case "pause":
          return await scheduler.pauseAll(actor, typeof input.reason === "string" ? input.reason : undefined);
        case "resume":
          return await scheduler.resumeAll(actor);
        case "create": {
          const hasCron = typeof input.cron === "string";
          const hasRunAt = typeof input.runAt === "string";
          if (hasCron === hasRunAt) throw new Error("Provide exactly one of cron or runAt.");
          if (typeof input.name !== "string" || typeof input.task !== "string" || typeof input.timeZone !== "string") {
            throw new Error("name, task, and timeZone are required to create a schedule.");
          }
          const schedule: CronScheduleInput = {
            name: input.name,
            task: input.task,
            timeZone: input.timeZone,
            ownerKeyId: actor,
            ...(hasCron ? { cron: input.cron as string } : { runAt: input.runAt as string }),
            ...(input.misfirePolicy === "skip" || input.misfirePolicy === "run-once" ? { misfirePolicy: input.misfirePolicy } : {}),
            ...(typeof input.maxRetries === "number" ? { maxRetries: input.maxRetries } : {}),
            ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
          };
          return await scheduler.create(schedule, actor);
        }
        case "enable":
        case "disable":
          if (!id) throw new Error("A schedule id is required.");
          return await scheduler.setEnabled(id, action === "enable", actor);
        case "cancel":
          if (!id) throw new Error("A schedule id is required.");
          return { id, cancelled: await scheduler.cancel(id, actor) };
        case "history":
          if (!id) throw new Error("A schedule id is required.");
          return { id, history: await scheduler.history(id, actor) };
        default:
          throw new Error("Unsupported cron management action.");
      }
    },
  }];
}
