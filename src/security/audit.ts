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
  decision: "allow" | "deny" | "approval_required" | "approval_denied" | "execution_started" | "completed" | "failed";
  /** Correlates the durable start record with its terminal outcome. */
  operationId?: string;
  /** Stable identifier for the durable, completed tool evidence record. */
  evidenceId?: string;
  reason?: string;
  input?: unknown;
  result?: unknown;
};

export interface SecurityAuditSink { record(event: SecurityAuditEvent): void | Promise<void>; }

export interface SecurityEvidenceReader {
  /** Returns only a completed evidence record that was durably persisted. */
  getEvidence(evidenceId: string): Promise<SecurityAuditEvent | undefined>;
}

export class CompositeSecurityAudit implements SecurityAuditSink, SecurityEvidenceReader {
  constructor(private readonly sinks: SecurityAuditSink[]) {}
  async record(event: SecurityAuditEvent) {
    for (const sink of this.sinks) await sink.record(event);
  }
  async getEvidence(evidenceId: string): Promise<SecurityAuditEvent | undefined> {
    for (const sink of this.sinks) {
      if ("getEvidence" in sink && typeof sink.getEvidence === "function") {
        const evidence = await (sink as SecurityAuditSink & SecurityEvidenceReader).getEvidence(evidenceId);
        if (evidence) return evidence;
      }
    }
    return undefined;
  }
}

export class MemorySecurityAudit implements SecurityAuditSink {
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
  list(): SecurityAuditEvent[] {
    return this.events.map(event => ({
      ...event,
      reason: event.reason === undefined ? undefined : String(redactSecrets(event.reason)),
      input: event.input === undefined ? undefined : redactSecrets(event.input),
      result: event.result === undefined ? undefined : redactSecrets(event.result),
    }));
  }
}
