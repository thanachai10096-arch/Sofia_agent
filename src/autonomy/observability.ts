import { createHash } from "node:crypto";

export type AutonomyEventType =
  | "job.started" | "job.completed" | "job.failed" | "job.cancelled"
  | "research.started" | "research.completed" | "research.failed"
  | "research.cycle.completed" | "research.cycle.failed" | "research.cycle.denied"
  | "skill.feedback.recorded" | "skill.promoted" | "skill.rolled_back";

export type AutonomyEventOutcome = "succeeded" | "failed" | "denied" | "cancelled";

export interface AutonomyEventInput {
  /** Host-resolved tenant/project scope; never accept this from model output. */
  scope: string;
  /** Stable host-generated key; retries with the same key are idempotent. */
  idempotencyKey: string;
  type: AutonomyEventType;
  outcome: AutonomyEventOutcome;
  /** Optional opaque host identifier, not user text or tool input/output. */
  subjectId?: string;
  durationMs?: number;
  /** Measured values only. Unknown values must be omitted, never reported as zero. */
  resource?: {
    cycles?: number;
    steps?: number;
    toolCalls?: number;
    spendUsd?: number;
  };
  occurredAt?: string;
}

export interface AutonomyEvent extends Omit<AutonomyEventInput, "idempotencyKey"> {
  id: string;
  idempotencyKey: string;
  recordedAt: string;
}

export interface AutonomyEventState {
  events: AutonomyEvent[];
  idempotency: Record<string, string>;
}

export interface AutonomyEventStore {
  transact<T>(scope: string, operation: (state: AutonomyEventState) => T | Promise<T>): Promise<T>;
}

export interface AutonomyObservabilitySummary {
  total: number;
  byType: Partial<Record<AutonomyEventType, number>>;
  byOutcome: Record<AutonomyEventOutcome, number>;
  duration: { samples: number; averageMs: number; maxMs: number };
  resources: { cycles: number; steps: number; toolCalls: number; spendUsd: number };
  latestEventAt: string | null;
}

const eventTypes = new Set<AutonomyEventType>([
  "job.started", "job.completed", "job.failed", "job.cancelled",
  "research.started", "research.completed", "research.failed",
  "research.cycle.completed", "research.cycle.failed", "research.cycle.denied",
  "skill.feedback.recorded", "skill.promoted", "skill.rolled_back",
]);
const outcomes = new Set<AutonomyEventOutcome>(["succeeded", "failed", "denied", "cancelled"]);
const MAX_EVENTS_PER_SCOPE = 20_000;
const MAX_PAGE_SIZE = 500;

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;
}

function validate(input: AutonomyEventInput): void {
  if (!input || typeof input !== "object" ||
      typeof input.scope !== "string" || !input.scope.trim() || input.scope.length > 512 ||
      typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200 ||
      !eventTypes.has(input.type) || !outcomes.has(input.outcome)) {
    throw new Error("Autonomy observability event identity or classification is invalid.");
  }
  if (input.subjectId !== undefined &&
      (typeof input.subjectId !== "string" || !input.subjectId.trim() || input.subjectId.length > 200)) {
    throw new Error("Autonomy observability subject identifier is invalid.");
  }
  if (input.durationMs !== undefined && !validCounter(input.durationMs)) {
    throw new Error("Autonomy observability duration must be a finite non-negative measurement.");
  }
  if (input.resource) {
    for (const value of Object.values(input.resource)) {
      if (!validCounter(value)) throw new Error("Autonomy observability resource values must be finite non-negative measurements.");
    }
  }
  if (input.occurredAt !== undefined && !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new Error("Autonomy observability event timestamp is invalid.");
  }
}

/**
 * Append-only, tenant-scoped operational telemetry. Deliberately excludes
 * prompts, findings, tool arguments/results, credentials and arbitrary labels.
 * Production hosts should provide a transactional durable AutonomyEventStore.
 */
export class AutonomyObservability {
  constructor(private readonly store: AutonomyEventStore) {}

  async record(input: AutonomyEventInput): Promise<{ recorded: boolean; event: AutonomyEvent }> {
    validate(input);
    return this.store.transact(input.scope, (state) => {
      const existingId = state.idempotency[input.idempotencyKey];
      if (existingId) {
        const existing = state.events.find((event) => event.id === existingId);
        if (!existing) throw new Error("Autonomy observability idempotency index is inconsistent.");
        const candidate = {
          type: input.type, outcome: input.outcome, subjectId: input.subjectId,
          durationMs: input.durationMs, resource: input.resource, occurredAt: input.occurredAt,
        };
        const previous = {
          type: existing.type, outcome: existing.outcome, subjectId: existing.subjectId,
          durationMs: existing.durationMs, resource: existing.resource, occurredAt: existing.occurredAt,
        };
        if (JSON.stringify(candidate) !== JSON.stringify(previous)) {
          throw new Error("Autonomy observability idempotency key was reused with different data.");
        }
        return { recorded: false, event: existing };
      }
      if (state.events.length >= MAX_EVENTS_PER_SCOPE) {
        throw new Error("Autonomy observability retention limit reached for this scope.");
      }
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const id = createHash("sha256")
        .update([input.scope, input.idempotencyKey].join("\n"))
        .digest("hex");
      const event: AutonomyEvent = {
        id, scope: input.scope, idempotencyKey: input.idempotencyKey,
        type: input.type, outcome: input.outcome,
        ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.resource !== undefined ? { resource: { ...input.resource } } : {}),
        occurredAt, recordedAt: new Date().toISOString(),
      };
      state.events.push(event);
      state.idempotency[input.idempotencyKey] = id;
      return { recorded: true, event };
    });
  }

  async list(scope: string, limit = 100): Promise<AutonomyEvent[]> {
    if (typeof scope !== "string" || !scope.trim() || scope.length > 512 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new Error("Autonomy observability query is invalid.");
    }
    return this.store.transact(scope, (state) =>
      state.events.slice(-limit).reverse().map((event) => structuredClone(event)));
  }

  async summarize(scope: string): Promise<AutonomyObservabilitySummary> {
    if (typeof scope !== "string" || !scope.trim() || scope.length > 512) {
      throw new Error("Autonomy observability scope is invalid.");
    }
    return this.store.transact(scope, (state) => {
      const summary: AutonomyObservabilitySummary = {
        total: state.events.length, byType: {},
        byOutcome: { succeeded: 0, failed: 0, denied: 0, cancelled: 0 },
        duration: { samples: 0, averageMs: 0, maxMs: 0 },
        resources: { cycles: 0, steps: 0, toolCalls: 0, spendUsd: 0 },
        latestEventAt: null,
      };
      let durationTotal = 0;
      for (const event of state.events) {
        summary.byType[event.type] = (summary.byType[event.type] ?? 0) + 1;
        summary.byOutcome[event.outcome] += 1;
        if (event.durationMs !== undefined) {
          summary.duration.samples += 1;
          durationTotal += event.durationMs;
          summary.duration.maxMs = Math.max(summary.duration.maxMs, event.durationMs);
        }
        if (event.resource) {
          summary.resources.cycles += event.resource.cycles ?? 0;
          summary.resources.steps += event.resource.steps ?? 0;
          summary.resources.toolCalls += event.resource.toolCalls ?? 0;
          summary.resources.spendUsd += event.resource.spendUsd ?? 0;
        }
        if (!summary.latestEventAt || event.occurredAt > summary.latestEventAt) {
          summary.latestEventAt = event.occurredAt;
        }
      }
      summary.duration.averageMs = summary.duration.samples
        ? durationTotal / summary.duration.samples : 0;
      return summary;
    });
  }
}

/** Test/development store. Use a transactional durable adapter in production. */
export class InMemoryAutonomyEventStore implements AutonomyEventStore {
  private readonly states = new Map<string, AutonomyEventState>();
  private readonly queues = new Map<string, Promise<void>>();

  async transact<T>(scope: string, operation: (state: AutonomyEventState) => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.queues.set(scope, queued);
    await previous;
    try {
      const state = structuredClone(this.states.get(scope) ?? { events: [], idempotency: {} });
      const result = await operation(state);
      this.states.set(scope, state);
      return result;
    } finally {
      release();
      if (this.queues.get(scope) === queued) this.queues.delete(scope);
    }
  }
}


/** Shape emitted by SofiaAutonomyRuntime; error text is intentionally discarded. */
export interface AutonomyRuntimeAuditEvent {
  type: "autonomy.research.started" | "autonomy.research.completed" | "autonomy.research.failed";
  principalId: string;
  at: string;
  cycleCount?: number;
}

/**
 * Bridges runtime lifecycle audit into bounded telemetry. Scope is the
 * authenticated principal supplied by the runtime; no model text or raw errors
 * are persisted. Hosts may compose this with their own audit sink.
 */
export function createAutonomyRuntimeAuditRecorder(
  telemetry: AutonomyObservability,
): (event: AutonomyRuntimeAuditEvent) => Promise<void> {
  return async (event) => {
    const mapping = {
      "autonomy.research.started": { type: "research.started", outcome: "succeeded" },
      "autonomy.research.completed": { type: "research.completed", outcome: "succeeded" },
      "autonomy.research.failed": { type: "research.failed", outcome: "failed" },
    } as const;
    const mapped = mapping[event.type];
    await telemetry.record({
      scope: event.principalId,
      idempotencyKey: `runtime:${event.type}:${event.at}`,
      type: mapped.type,
      outcome: mapped.outcome,
      occurredAt: event.at,
      ...(event.cycleCount !== undefined ? { resource: { cycles: event.cycleCount } } : {}),
    });
  };
}
