import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JobRuntime, JobRecord } from "./job-runtime.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";

export type MisfirePolicy = "skip" | "run-once";
export type ScheduleStatus = "enabled" | "disabled";
export interface CronScheduleInput {
  name: string;
  task: string;
  cron: string;
  timeZone: string;
  ownerKeyId: string;
  enabled?: boolean;
  misfirePolicy?: MisfirePolicy;
  maxRetries?: number;
  timeoutMs?: number;
}
export interface CronSchedule extends CronScheduleInput {
  id: string;
  status: ScheduleStatus;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastJobId?: string;
  consecutiveFailures: number;
}
export interface CronExecution {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt?: string;
  status: "claimed" | "running" | "completed" | "failed" | "cancelled" | "skipped";
  jobId?: string;
  attempt: number;
  error?: string;
}
export interface CronAuditEvent {
  at: string;
  actor: string;
  action: string;
  scheduleId: string;
  detail?: string;
}
interface SchedulerState {
  schedules: CronSchedule[];
  history: CronExecution[];
  audit: CronAuditEvent[];
}
export interface CronStore {
  transact<T>(operation: (state: SchedulerState) => Promise<T> | T): Promise<T>;
}
export interface CronSchedulerOptions {
  store?: CronStore;
  now?: () => Date;
  authorize?: (actor: string, action: "create" | "update" | "cancel" | "run", schedule?: CronSchedule) => Promise<boolean> | boolean;
  maxConcurrent?: number;
  audit?: (event: CronAuditEvent) => void | Promise<void>;
}

/** File-backed store. Exclusive lock + atomic rename serializes claims across local processes. */
export class FileCronStore implements CronStore {
  private readonly file: string;
  private readonly lock: string;
  constructor(namespace = process.cwd(), root = sofiaStateDirectory("cron")) {
    const id = createHash("sha256").update(namespace).digest("hex");
    this.file = path.join(root, id + ".json");
    this.lock = this.file + ".lock";
  }
  private async read(): Promise<SchedulerState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<SchedulerState>;
      return { schedules: parsed.schedules ?? [], history: parsed.history ?? [], audit: parsed.audit ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schedules: [], history: [], audit: [] };
      throw error;
    }
  }
  async transact<T>(operation: (state: SchedulerState) => Promise<T> | T): Promise<T> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    while (!handle) {
      try {
        handle = await fs.open(this.lock, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await fs.stat(this.lock);
          if (Date.now() - info.mtimeMs > 30_000) {
            await fs.rm(this.lock, { force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for cron scheduler state lock");
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    }
    try {
      const state = await this.read();
      const result = await operation(state);
      const temporary = this.file + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, this.file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result;
    } finally {
      await handle.close();
      await fs.rm(this.lock, { force: true });
    }
  }
}

function parseField(source: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const [base = "", stepRaw] = part.split("/");
    if (part.split("/").length > 2) throw new Error("Invalid cron field: " + source);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error("Invalid cron step: " + source);
    let start: number, end: number;
    if (base === "*") { start = min; end = max; }
    else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw new Error("Invalid cron range: " + source);
      start = Number(range[0]); end = Number(range[1]);
    } else { start = Number(base); end = stepRaw === undefined ? start : max; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error("Cron value out of range: " + source);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}
interface ParsedCron { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number>; dayWildcard: boolean; weekdayWildcard: boolean; }
function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expression must contain exactly five fields");
  return {
    minute: parseField(fields[0] ?? "", 0, 59), hour: parseField(fields[1] ?? "", 0, 23),
    day: parseField(fields[2] ?? "", 1, 31), month: parseField(fields[3] ?? "", 1, 12),
    weekday: parseField(fields[4] ?? "", 0, 7), dayWildcard: fields[2] === "*", weekdayWildcard: fields[4] === "*",
  };
}
function localParts(date: Date, timeZone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric",
    weekday: "short", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { minute: Number(get("minute")), hour: Number(get("hour")), day: Number(get("day")), month: Number(get("month")), weekday };
}
export function nextCronOccurrence(expression: string, timeZone: string, after: Date): Date {
  const cron = parseCron(expression);
  // Validate the zone explicitly before searching.
  new Intl.DateTimeFormat("en-US", { timeZone }).format(after);
  const cursor = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = cursor + 366 * 24 * 60 * 60_000 * 2;
  for (let instant = cursor; instant <= limit; instant += 60_000) {
    const p = localParts(new Date(instant), timeZone);
    const dayMatch = cron.day.has(p.day);
    const weekdayMatch = cron.weekday.has(p.weekday) || (p.weekday === 0 && cron.weekday.has(7));
    const calendarMatch = cron.dayWildcard && cron.weekdayWildcard
      ? true
      : cron.dayWildcard ? weekdayMatch
      : cron.weekdayWildcard ? dayMatch : dayMatch || weekdayMatch;
    if (cron.minute.has(p.minute) && cron.hour.has(p.hour) && cron.month.has(p.month) && calendarMatch) return new Date(instant);
  }
  throw new Error("Could not find a cron occurrence within two years");
}

export class CronScheduler {
  private readonly store: CronStore;
  private readonly now: () => Date;
  private readonly authorize: NonNullable<CronSchedulerOptions["authorize"]>;
  private readonly maxConcurrent: number;
  private readonly auditCallback?: CronSchedulerOptions["audit"];
  private ticking = false;
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly runtime: JobRuntime, options: CronSchedulerOptions = {}) {
    this.store = options.store ?? new FileCronStore();
    this.now = options.now ?? (() => new Date());
    this.authorize = options.authorize ?? ((actor, _action, schedule) => !!actor && (!schedule || actor === schedule.ownerKeyId));
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.auditCallback = options.audit;
  }
  private async recordAudit(state: SchedulerState, event: CronAuditEvent): Promise<void> {
    state.audit.push(event);
    if (state.audit.length > 2_000) state.audit.splice(0, state.audit.length - 2_000);
    await this.auditCallback?.(event);
  }
  async create(input: CronScheduleInput, actor: string): Promise<CronSchedule> {
    if (!await this.authorize(actor, "create")) throw new Error("Not authorized to create cron schedule");
    if (!input.name.trim() || !input.task.trim() || !input.ownerKeyId.trim()) throw new Error("name, task and ownerKeyId are required");
    nextCronOccurrence(input.cron, input.timeZone, this.now());
    const now = this.now().toISOString();
    const schedule: CronSchedule = {
      ...input, enabled: undefined, misfirePolicy: input.misfirePolicy ?? "skip",
      maxRetries: Math.max(0, Math.min(10, Math.floor(input.maxRetries ?? 0))),
      timeoutMs: Math.max(1_000, Math.min(3_600_000, Math.floor(input.timeoutMs ?? 120_000))),
      id: randomUUID(), status: input.enabled === false ? "disabled" : "enabled",
      createdAt: now, updatedAt: now,
      nextRunAt: nextCronOccurrence(input.cron, input.timeZone, this.now()).toISOString(),
      consecutiveFailures: 0,
    };
    return this.store.transact(async state => {
      state.schedules.push(schedule);
      await this.recordAudit(state, { at: now, actor, action: "schedule.created", scheduleId: schedule.id });
      return { ...schedule };
    });
  }
  async list(actor: string): Promise<CronSchedule[]> {
    return this.store.transact(state => state.schedules.filter(s => s.ownerKeyId === actor).map(s => ({ ...s })));
  }
  async setEnabled(id: string, enabled: boolean, actor: string): Promise<CronSchedule> {
    return this.store.transact(async state => {
      const schedule = state.schedules.find(s => s.id === id);
      if (!schedule) throw new Error("Unknown cron schedule");
      if (!await this.authorize(actor, "update", schedule)) throw new Error("Not authorized to update cron schedule");
      schedule.status = enabled ? "enabled" : "disabled";
      schedule.updatedAt = this.now().toISOString();
      await this.recordAudit(state, { at: schedule.updatedAt, actor, action: enabled ? "schedule.enabled" : "schedule.disabled", scheduleId: id });
      return { ...schedule };
    });
  }
  async cancel(id: string, actor: string): Promise<boolean> {
    const target = await this.store.transact(async state => {
      const schedule = state.schedules.find(s => s.id === id);
      if (!schedule) return undefined;
      if (!await this.authorize(actor, "cancel", schedule)) throw new Error("Not authorized to cancel cron schedule");
      schedule.status = "disabled";
      schedule.updatedAt = this.now().toISOString();
      await this.recordAudit(state, { at: schedule.updatedAt, actor, action: "schedule.cancelled", scheduleId: id });
      return { ...schedule, jobId: schedule.lastJobId };
    });
    if (!target) return false;
    const controller = this.active.get(id);
    controller?.abort(new Error("Scheduled execution cancelled"));
    if (target.jobId) await this.runtime.cancel(target.jobId);
    return true;
  }
  async history(id: string, actor: string): Promise<CronExecution[]> {
    return this.store.transact(async state => {
      const schedule = state.schedules.find(s => s.id === id);
      if (!schedule) throw new Error("Unknown cron schedule");
      if (!await this.authorize(actor, "update", schedule)) throw new Error("Not authorized to view cron history");
      return state.history.filter(h => h.scheduleId === id).map(h => ({ ...h }));
    });
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      while (this.active.size < this.maxConcurrent) {
        const claim = await this.store.transact(async state => {
          const now = this.now();
          const due = state.schedules.filter(s => s.status === "enabled" && Date.parse(s.nextRunAt) <= now.getTime())
            .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0];
          if (!due) return undefined;
          const scheduledFor = due.nextRunAt;
          const next = nextCronOccurrence(due.cron, due.timeZone, new Date(scheduledFor));
          due.nextRunAt = next.toISOString();
          due.updatedAt = now.toISOString();
          const previous = state.history.find(h => h.scheduleId === due.id && h.scheduledFor === scheduledFor);
          if (previous) return undefined;
          const execution: CronExecution = {
            id: randomUUID(), scheduleId: due.id, scheduledFor, startedAt: now.toISOString(),
            status: "claimed", attempt: 0,
          };
          state.history.push(execution);
          await this.recordAudit(state, { at: now.toISOString(), actor: "scheduler", action: "schedule.claimed", scheduleId: due.id, detail: scheduledFor });
          return { schedule: { ...due, nextRunAt: scheduledFor }, executionId: execution.id, scheduledFor };
        });
        if (!claim) break;
        if (this.active.size >= this.maxConcurrent) break;
        const controller = new AbortController();
        this.active.set(claim.schedule.id, controller);
        void this.executeClaim(claim.schedule, claim.executionId, claim.scheduledFor, controller);
      }
    } finally { this.ticking = false; }
  }
  private async executeClaim(schedule: CronSchedule, executionId: string, scheduledFor: string, controller: AbortController): Promise<void> {
    let job: JobRecord | undefined;
    let errorText: string | undefined;
    let status: CronExecution["status"] = "failed";
    try {
      const submitted = await this.runtime.submit({ task: schedule.task, ownerKeyId: schedule.ownerKeyId });
      job = submitted;
      await this.store.transact(async state => {
        const execution = state.history.find(h => h.id === executionId);
        if (execution) { execution.status = "running"; execution.jobId = submitted.id; }
        const current = state.schedules.find(s => s.id === schedule.id);
        if (current) current.lastJobId = submitted.id;
      });
      const timeout = new AbortController();
      const timeoutId = setTimeout(() => timeout.abort(new Error("Scheduled task timed out")), schedule.timeoutMs);
      const onAbort = () => timeout.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await this.waitForJob(submitted.id, timeout.signal);
        status = result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed";
        if (status === "failed") errorText = result.error ?? "Scheduled job failed";
      } finally {
        clearTimeout(timeoutId);
        controller.signal.removeEventListener("abort", onAbort);
      }
    } catch (error) { errorText = error instanceof Error ? error.message : String(error); }
    await this.store.transact(async state => {
      const execution = state.history.find(h => h.id === executionId);
      const current = state.schedules.find(s => s.id === schedule.id);
      if (execution) {
        execution.status = status;
        execution.finishedAt = this.now().toISOString();
        if (job) execution.jobId = job.id;
        if (errorText) execution.error = errorText;
      }
      if (current) {
        current.lastRunAt = this.now().toISOString();
        current.lastJobId = job?.id;
        current.consecutiveFailures = status === "completed" ? 0 : current.consecutiveFailures + 1;
      }
      await this.recordAudit(state, { at: this.now().toISOString(), actor: "scheduler", action: "schedule.finished", scheduleId: schedule.id, detail: status });
    }).catch(() => undefined);
    this.active.delete(schedule.id);
  }
  private async waitForJob(id: string, signal: AbortSignal): Promise<JobRecord> {
    while (!signal.aborted) {
      const record = await this.runtime.get(id);
      if (!record) throw new Error("Scheduled runtime job disappeared");
      if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") return record;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Scheduled task aborted")); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    throw signal.reason ?? new Error("Scheduled task aborted");
  }
}
