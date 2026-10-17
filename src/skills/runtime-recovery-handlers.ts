import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(label + " must be an object.");
  return value as RecordValue;
}
function text(value: unknown, label: string, max = 240): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(label + " must be non-empty text up to " + max + " characters.");
  return value.trim();
}
function array(value: unknown, label: string, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(label + " must be an array with at most " + max + " entries.");
  return value;
}

/** Validates and topologically orders a dependency graph; never executes scheduled work. */
export const dependencyScheduler = (input: unknown) => {
  const value = record(input, "input");
  const tasks = array(value.tasks, "tasks", 100).map((item, index) => {
    const task = record(item, "tasks[" + index + "]");
    const id = text(task.id, "tasks[" + index + "].id", 120);
    const dependencies = array(task.dependencies ?? [], "tasks[" + index + "].dependencies", 100).map((dependency, depIndex) =>
      text(dependency, "tasks[" + index + "].dependencies[" + depIndex + "]", 120));
    if (new Set(dependencies).size !== dependencies.length) throw new TypeError("Task " + id + " contains duplicate dependencies.");
    if (dependencies.includes(id)) throw new TypeError("Task " + id + " cannot depend on itself.");
    return { id, dependencies };
  });
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new TypeError("Task IDs must be unique.");
  for (const task of tasks) for (const dependency of task.dependencies) {
    if (!byId.has(dependency)) throw new TypeError("Task " + task.id + " references unknown dependency " + dependency + ".");
  }
  const remaining = new Map(tasks.map(task => [task.id, new Set(task.dependencies)]));
  const ordered: string[] = [];
  while (remaining.size) {
    const ready = tasks.filter(task => remaining.has(task.id) && [...remaining.get(task.id)!].every(id => ordered.includes(id)));
    if (!ready.length) throw new TypeError("Dependency graph contains a cycle.");
    for (const task of ready) { ordered.push(task.id); remaining.delete(task.id); }
  }
  const batchMap = new Map<number, string[]>();
  for (const id of ordered) {
    const task = byId.get(id)!;
    const batchIndex = task.dependencies.length ? Math.max(...task.dependencies.map(dep => ordered.indexOf(dep))) + 1 : 0;
    const batch = batchMap.get(batchIndex) ?? [];
    batch.push(id); batchMap.set(batchIndex, batch);
  }
  return { order: ordered, batches: [...batchMap.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]), taskCount: tasks.length, executesTasks: false };
};

/** Produces a bounded, secret-agnostic summary from supplied execution events. */
export const executionTraceAnalyzer = (input: unknown) => {
  const value = record(input, "input");
  const events = array(value.events, "events", 500).map((item, index) => {
    const event = record(item, "events[" + index + "]");
    const status = event.status;
    if (!["started", "completed", "failed", "cancelled", "skipped"].includes(String(status))) throw new TypeError("events[" + index + "].status is invalid.");
    const timestamp = event.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) throw new TypeError("events[" + index + "].timestamp must be a non-negative finite number.");
    return { id: text(event.id, "events[" + index + "].id", 120), status: status as string, timestamp };
  });
  const counts = { started: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const event of events) counts[event.status as keyof typeof counts] += 1;
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
  return {
    eventCount: events.length, counts,
    durationMs: ordered.length > 1 ? ordered[ordered.length - 1]!.timestamp - ordered[0]!.timestamp : 0,
    failedEventIds: events.filter(event => event.status === "failed").map(event => event.id),
    needsRecoveryReview: counts.failed > 0 || counts.cancelled > 0, mutatesTrace: false,
  };
};

/** Recommends a safe recovery decision from explicit evidence; never resumes jobs. */
export const crashRecoveryAdvisor = (input: unknown) => {
  const value = record(input, "input");
  const state = value.state;
  if (!["queued", "running", "checkpointed", "completed", "failed", "cancelled"].includes(String(state))) throw new TypeError("state is invalid.");
  const flags = { hasCheckpoint: value.hasCheckpoint, idempotent: value.idempotent, sideEffectsStarted: value.sideEffectsStarted };
  for (const [key, flag] of Object.entries(flags)) if (typeof flag !== "boolean") throw new TypeError(key + " must be boolean.");
  const stateValue = state as string;
  let recommendation: "no-action" | "resume-from-checkpoint-review" | "retry-after-review" | "manual-investigation" = "manual-investigation";
  let reason = "Evidence is insufficient for a safe recovery decision.";
  if (stateValue === "completed" || stateValue === "cancelled") {
    recommendation = "no-action"; reason = "Completed or cancelled jobs are not restarted automatically.";
  } else if (stateValue === "checkpointed" && flags.hasCheckpoint) {
    recommendation = "resume-from-checkpoint-review"; reason = "A checkpoint exists; validate it and re-authorize before resuming.";
  } else if ((stateValue === "failed" || stateValue === "running") && flags.idempotent && !flags.sideEffectsStarted) {
    recommendation = "retry-after-review"; reason = "Retry may be considered after policy and environment review because no side effects were reported.";
  }
  return { state: stateValue, recommendation, reason, automaticResume: false, requiresHumanReview: recommendation !== "no-action" };
};

const HANDLERS: ReadonlyArray<{ id: string; handler: AdvancedSkillHandler }> = [
  { id: "runtime.04", handler: dependencyScheduler },
  { id: "runtime.05", handler: executionTraceAnalyzer },
  { id: "runtime.07", handler: crashRecoveryAdvisor },
];
export function registerVerifiedRuntimeRecoverySkills(registry: AdvancedSkillRegistry): string[] {
  const registered: string[] = [];
  for (const item of HANDLERS) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}
