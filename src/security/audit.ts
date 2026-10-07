import type { RiskLevel } from "./guard.js";
import { redactSecrets } from "./guard.js";

export type SecurityAuditEvent = {
  id: string;
  at: string;
  runId: string;
  principalId?: string | undefined;
  toolName: string;
  actionHash: string;
  risk: RiskLevel;
  decision: "allow" | "deny" | "approval_required" | "approval_denied" | "completed" | "failed";
  reason?: string;
  input?: unknown;
  result?: unknown;
};

export interface SecurityAuditSink { record(event: SecurityAuditEvent): void | Promise<void>; }

export class MemorySecurityAudit implements SecurityAuditSink {
  private readonly events: SecurityAuditEvent[] = [];
  constructor(private readonly maxEvents = 2000) {}
  record(event: SecurityAuditEvent): void {
    this.events.push({
      ...event,
      input: event.input === undefined ? undefined : redactSecrets(event.input),
      result: event.result === undefined ? undefined : redactSecrets(event.result),
    });
    while (this.events.length > this.maxEvents) this.events.shift();
  }
  list(): SecurityAuditEvent[] { return this.events.map(event => ({ ...event })); }
}
