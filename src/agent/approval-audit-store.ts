import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ApprovalRequest } from "./approval.js";

export type ApprovalAuditStatus = "requested" | "approved" | "denied" | "expired" | "interrupted";
export interface ApprovalAuditEvent {
  approvalId: string;
  ownerId: string;
  runId: string;
  toolName: string;
  actionHash: string;
  risk: ApprovalRequest["risk"];
  status: ApprovalAuditStatus;
  at: number;
}

/** Append-only, secret-free audit trail. Pending requests are never replayed after restart. */
export class FileApprovalAuditStore {
  private readonly file: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* platform may not support chmod */ }
    this.file = path.join(directory, "approval-audit.jsonl");
  }

  record(event: ApprovalAuditEvent): void {
    if (!event.approvalId || !event.ownerId || !event.runId || !event.toolName ||
        !/^[a-f0-9]{64}$/i.test(event.actionHash) || !Number.isSafeInteger(event.at)) {
      throw new Error("Invalid approval audit event.");
    }
    try {
      appendFileSync(this.file, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
      try { chmodSync(this.file, 0o600); } catch { /* platform may not support chmod */ }
    } catch {
      throw new Error("Approval audit persistence failed.");
    }
  }

  /** Mark orphaned pending requests as interrupted; never restore them as actionable. */
  recoverInterrupted(now = Date.now()): number {
    const latest = new Map<string, ApprovalAuditEvent>();
    let lines: string[];
    try { lines = readFileSync(this.file, "utf8").split("\n"); }
    catch { return 0; }
    for (const line of lines) {
      if (!line) continue;
      try {
        const value = JSON.parse(line) as ApprovalAuditEvent;
        if (value && typeof value.approvalId === "string" && typeof value.ownerId === "string" &&
            typeof value.runId === "string" && typeof value.toolName === "string" &&
            /^[a-f0-9]{64}$/i.test(value.actionHash) &&
            ["requested", "approved", "denied", "expired", "interrupted"].includes(value.status) &&
            Number.isSafeInteger(value.at)) latest.set(value.approvalId, value);
      } catch { /* ignore a torn/corrupt line; never treat it as authority */ }
    }
    let recovered = 0;
    for (const event of latest.values()) {
      if (event.status !== "requested") continue;
      this.record({ ...event, status: "interrupted", at: now });
      recovered++;
    }
    return recovered;
  }

  list(ownerId: string, limit = 100): ApprovalAuditEvent[] {
    if (!ownerId || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) return [];
    let lines: string[];
    try { lines = readFileSync(this.file, "utf8").split("\n"); }
    catch { return []; }
    const events: ApprovalAuditEvent[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as ApprovalAuditEvent;
        if (event.ownerId === ownerId && /^[a-f0-9]{64}$/i.test(event.actionHash) &&
            ["requested", "approved", "denied", "expired", "interrupted"].includes(event.status) &&
            Number.isSafeInteger(event.at)) events.push(event);
      } catch { /* skip invalid line */ }
    }
    return events.slice(-limit).reverse();
  }
}
