import {
  type RestoreJournalRecord,
  type RestoreJournalStore,
  validateRestoreJournalRecord,
} from "./restore-journal.js";

export type RestoreRecoveryDisposition =
  | "completed"
  | "rolled_back"
  | "manual_recovery_required"
  | "interrupted_before_apply"
  | "interrupted_during_apply"
  | "interrupted_during_rollback";

export interface RestoreRecoveryItem {
  transactionId: string;
  revision: number;
  phase: RestoreJournalRecord["phase"];
  disposition: RestoreRecoveryDisposition;
  requiresOperatorReview: boolean;
  targetCount: number;
  appliedTargets: string[];
  pendingTargets: string[];
  failureCode?: string;
}

export interface RestoreRecoveryReport {
  scannedAt: string;
  total: number;
  completed: number;
  rolledBack: number;
  needsRecovery: number;
  items: RestoreRecoveryItem[];
}

function inspectRecord(value: unknown): RestoreRecoveryItem {
  const record = validateRestoreJournalRecord(value);
  const appliedTargets = record.targets
    .filter((target) => ["applied", "rollback_pending", "rolled_back", "rollback_failed"].includes(target.phase))
    .map((target) => target.name);
  const pendingTargets = record.targets
    .filter((target) => target.phase === "pending" || target.phase === "applying")
    .map((target) => target.name);

  let disposition: RestoreRecoveryDisposition;
  switch (record.phase) {
    case "committed": disposition = "completed"; break;
    case "rolled_back": disposition = "rolled_back"; break;
    case "rollback_failed": disposition = "manual_recovery_required"; break;
    case "prepared": disposition = "interrupted_before_apply"; break;
    case "applying": disposition = "interrupted_during_apply"; break;
    case "rollback_required":
    case "rolling_back": disposition = "interrupted_during_rollback"; break;
  }

  return {
    transactionId: record.transactionId,
    revision: record.revision,
    phase: record.phase,
    disposition,
    requiresOperatorReview: disposition !== "completed" && disposition !== "rolled_back",
    targetCount: record.targets.length,
    appliedTargets,
    pendingTargets,
    ...(record.failureCode ? { failureCode: record.failureCode } : {}),
  };
}

/**
 * Read-only startup inspection for restore intents. It never resumes,
 * rolls back, deletes, or mutates a target. Durable snapshot storage and
 * adapter reconstruction are prerequisites for safe automatic recovery.
 */
export async function scanRestoreRecovery(
  store: RestoreJournalStore,
  scannedAt = new Date().toISOString(),
): Promise<RestoreRecoveryReport> {
  if (!store || typeof store.list !== "function") {
    throw new Error("A restore journal store is required for recovery inspection.");
  }
  if (!Number.isFinite(Date.parse(scannedAt)) || new Date(scannedAt).toISOString() !== scannedAt) {
    throw new Error("Restore recovery scan timestamp must be canonical ISO-8601.");
  }

  const items = (await store.list()).map(inspectRecord);
  items.sort((a, b) => a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0);
  const completed = items.filter((item) => item.disposition === "completed").length;
  const rolledBack = items.filter((item) => item.disposition === "rolled_back").length;
  return {
    scannedAt,
    total: items.length,
    completed,
    rolledBack,
    needsRecovery: items.length - completed - rolledBack,
    items,
  };
}
