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
