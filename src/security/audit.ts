import type { RiskLevel } from "./guard.js";
import { redactSecrets } from "./guard.js";

export type SecurityAuditEvent = {
  id: string;
  /** Links a terminal execution event to its write-ahead execution_started receipt. */
  relatedEventId?: string;
  at: string;
  runId: string;
  principalId?: string | undefined;
  toolName: string;
  actionHash: string;
  risk: RiskLevel;
  decision: "allow" | "deny" | "approval_required" | "approval_denied" | "approval_approved" | "execution_started" | "completed" | "failed";
  reason?: string;
  input?: unknown;
  result?: unknown;
};

export interface SecurityAuditSink {
  /** True only when records survive process restart and can be read back. */
  readonly durable?: boolean;
  record(event: SecurityAuditEvent): void | Promise<void>;
  read?(id: string): SecurityAuditEvent | undefined | Promise<SecurityAuditEvent | undefined>;
  /** Enumerates retained audit events for restart-time reconciliation. */
  list?(): SecurityAuditEvent[] | Promise<SecurityAuditEvent[]>;
}
export class CompositeSecurityAudit implements SecurityAuditSink {
  constructor(private readonly sinks: SecurityAuditSink[]) {}
  get durable(): boolean {
    return this.sinks.some((sink) => sink.durable === true && typeof sink.read === "function");
  }
  async record(event: SecurityAuditEvent): Promise<void> {
    for (const sink of this.sinks) await sink.record(event);
  }
  async read(id: string): Promise<SecurityAuditEvent | undefined> {
    for (const sink of this.sinks) {
      if (sink.durable !== true || !sink.read) continue;
      const event = await sink.read(id);
      if (event) return event;
    }
    return undefined;
  }
  async list(): Promise<SecurityAuditEvent[]> {
    const batches = await Promise.all(this.sinks.filter((sink) => sink.list).map((sink) => sink.list!()));
    return batches.flat();
  }
}

/**
 * Finds write-ahead execution receipts with no matching terminal outcome.
 * A terminal event only closes a receipt when all action identity fields match.
 * These records are indeterminate, not safe to replay automatically.
 */
export function findIndeterminateExecutions(events: readonly SecurityAuditEvent[]): SecurityAuditEvent[] {
  const resolved = new Set<string>();
  for (const event of events) {
    if ((event.decision !== "completed" && event.decision !== "failed") || !event.relatedEventId) continue;
    const start = events.find((candidate) =>
      candidate.id === event.relatedEventId &&
      candidate.decision === "execution_started" &&
      candidate.runId === event.runId &&
      candidate.principalId === event.principalId &&
      candidate.toolName === event.toolName &&
      candidate.actionHash === event.actionHash,
    );
    if (start) resolved.add(start.id);
  }
  return events.filter((event) =>
    event.decision === "execution_started" && !resolved.has(event.id),
  );
}

export class MemorySecurityAudit implements SecurityAuditSink {
  readonly durable = false;
  private readonly events: SecurityAuditEvent[] = [];
  constructor(private readonly maxEvents = 2000) {}
  record(event: SecurityAuditEvent): void {
    this.events.push({
      ...event,
      reason: event.reason === undefined ? undefined : String(redactSecrets(event.reason)),
      input: event.input === undefined ? undefined : redactSecrets(event.input),
      result: event.result === undefined ? undefined : redactSecrets(event.result),
    });
    while (this.events.length > this.maxEvents) this.events.shift();
  }
  read(id: string): SecurityAuditEvent | undefined {
    const event = this.events.find((item) => item.id === id);
    return event ? { ...event } : undefined;
  }
  list(): SecurityAuditEvent[] {
    return this.events.map(event => ({
      ...event,
      reason: event.reason === undefined ? undefined : String(redactSecrets(event.reason)),
      input: event.input === undefined ? undefined : redactSecrets(event.input),
      result: event.result === undefined ? undefined : redactSecrets(event.result),
    }));
  }
}
