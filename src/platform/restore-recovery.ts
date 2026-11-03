import {
  advanceRestoreJournal,
  type RestoreJournalRecord,
  type RestoreJournalStore,
  validateRestoreJournalRecord,
} from "./restore-journal.js";
import type { RestoreSnapshotStore } from "./restore-snapshot-store.js";

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


export interface RestoreRecoveryAdapter {
  name: string;
  paths: readonly string[];
  rollbackFromSnapshotBytes(bytes: Uint8Array): Promise<void>;
}

export interface RecoverInterruptedRestoreOptions {
  transactionId: string;
  journal: RestoreJournalStore;
  snapshotStore: RestoreSnapshotStore;
  adapters: readonly RestoreRecoveryAdapter[];
  /**
   * Must provide a process-wide exclusive maintenance lock for this transaction.
   * Recovery without mutual exclusion could race another recovery worker.
   */
  withExclusiveLock<T>(transactionId: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Explicitly roll back one interrupted transaction using its verified durable
 * snapshots. The caller must supply a process-wide lock and adapters bound to
 * the same destinations as the original transaction.
 */
export async function recoverInterruptedRestoreTransaction(
  options: RecoverInterruptedRestoreOptions,
): Promise<RestoreJournalRecord> {
  const { transactionId, journal, snapshotStore, adapters } = options;
  if (!/^[a-f0-9-]{16,64}$/iu.test(transactionId)) {
    throw new Error("Restore recovery transaction ID is invalid.");
  }
  if (!journal || !snapshotStore || typeof options.withExclusiveLock !== "function") {
    throw new Error("Restore recovery requires journal, snapshot storage, and an exclusive lock.");
  }
  if (!Array.isArray(adapters)) throw new Error("Restore recovery adapters must be an array.");
  const byName = new Map<string, RestoreRecoveryAdapter>();
  for (const adapter of adapters) {
    if (!adapter || typeof adapter.name !== "string" || !adapter.name.trim() ||
        !Array.isArray(adapter.paths) || typeof adapter.rollbackFromSnapshotBytes !== "function" ||
        byName.has(adapter.name)) {
      throw new Error("Restore recovery adapter configuration is invalid.");
    }
    byName.set(adapter.name, adapter);
  }

  return options.withExclusiveLock(transactionId, async () => {
    let record = await journal.read(transactionId);
    if (!record) throw new Error("Restore recovery journal record was not found.");
    record = validateRestoreJournalRecord(record);
    if (record.phase === "committed" || record.phase === "rolled_back") return record;
    if (record.phase === "rollback_failed") {
      throw new Error("Restore transaction has a failed rollback and requires manual recovery.");
    }

    const rollbackBytes = new Map<string, Uint8Array>();
    for (const target of record.targets) {
      const adapter = byName.get(target.name);
      if (!adapter || adapter.paths.length !== target.paths.length ||
          adapter.paths.some((item) => !target.paths.includes(item))) {
        throw new Error(`Restore recovery adapter does not match journal target: ${target.name}`);
      }
      if (target.phase === "rollback_failed") {
        throw new Error(`Restore target ${target.name} previously failed rollback and requires manual recovery.`);
      }
      if (target.phase !== "pending" && target.phase !== "rolled_back") {
        if (!target.rollbackSnapshotRef || !target.rollbackSnapshotSha256) {
          throw new Error(`Restore target ${target.name} has no durable rollback snapshot.`);
        }
        // Verify and load every required snapshot before mutating any target.
        // A corrupt later snapshot must not leave earlier targets half-restored.
        const bytes = await snapshotStore.read(target.rollbackSnapshotRef, target.rollbackSnapshotSha256);
        rollbackBytes.set(target.name, bytes);
      }
    }

    const append = async (
      phase: RestoreJournalRecord["phase"],
      targets: RestoreJournalRecord["targets"],
      failureCode?: string,
    ) => {
      const next = advanceRestoreJournal(record!, {
        phase,
        updatedAt: new Date().toISOString(),
        targets,
        ...(failureCode ? { failureCode } : {}),
      });
      await journal.append(next, record!.revision);
      record = next;
    };

    const pendingTargets = record.targets.map((target) => ({
      ...target,
      phase: target.phase === "pending" || target.phase === "rolled_back"
        ? target.phase
        : "rollback_pending" as const,
    }));
    if (record.phase === "prepared" || record.phase === "applying") {
      await append("rollback_required", pendingTargets, "startup_recovery_requested");
    }
    if (record.phase === "rollback_required") {
      await append("rolling_back", record.targets, "startup_recovery_requested");
    }

    for (const target of [...record.targets].reverse()) {
      if (target.phase === "pending" || target.phase === "rolled_back") continue;
      const adapter = byName.get(target.name)!;
      const bytes = rollbackBytes.get(target.name);
      if (!bytes) throw new Error(`Verified rollback snapshot is missing for target: ${target.name}`);
      try {
        await adapter.rollbackFromSnapshotBytes(bytes);
      } catch (error) {
        const updated = record.targets.map((item) =>
          item.name === target.name ? { ...item, phase: "rollback_failed" as const } : item);
        try {
          await append("rollback_failed", updated, "startup_recovery_failed");
        } catch (journalError) {
          throw new Error(
            `Restore recovery failed for ${target.name}, and failure could not be journaled: ${journalError instanceof Error ? journalError.message : String(journalError)}`,
            { cause: error },
          );
        }
        throw new Error(
          `Restore recovery failed for ${target.name}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      // Keep the adapter operation and its journal acknowledgement in separate
      // failure domains. If the target rollback succeeds but this append fails,
      // leave the durable phase as rollback_pending so a later attempt can replay
      // the idempotent rollback instead of falsely recording rollback_failed.
      const updated = record.targets.map((item) =>
        item.name === target.name ? { ...item, phase: "rolled_back" as const } : item);
      await append("rolling_back", updated, "startup_recovery_requested");
    }

    await append("rolled_back", record.targets, "startup_recovery_completed");
    return record!;
  });
}
