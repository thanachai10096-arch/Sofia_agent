import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FinancialActionEvent, FinancialActionRecord, FinancialActionStore, FinancialLedger } from "./financial-actions.js";

const HASH = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["submitting", "processing", "succeeded", "failed", "unknown"]);
function validRecord(value: unknown, ownerId: string, idempotencyHash: string): value is FinancialActionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<FinancialActionRecord>;
  return typeof r.id === "string" && /^[0-9a-f-]{36}$/i.test(r.id) && r.ownerId === ownerId && r.idempotencyHash === idempotencyHash &&
    typeof r.requestFingerprint === "string" && HASH.test(r.requestFingerprint) && typeof r.orderReference === "string" && r.orderReference.length > 0 &&
    Number.isSafeInteger(r.amountMinor) && (r.amountMinor ?? 0) > 0 && typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) &&
    typeof r.status === "string" && STATUSES.has(r.status) && typeof r.createdAt === "string" && Number.isFinite(Date.parse(r.createdAt)) &&
    typeof r.updatedAt === "string" && Number.isFinite(Date.parse(r.updatedAt)) && typeof r.approvalId === "string" && typeof r.reason === "string" &&
    (r.provider === undefined || typeof r.provider === "string") && (r.providerPaymentId === undefined || typeof r.providerPaymentId === "string");
}
function validEvent(value: FinancialActionEvent): boolean {
  return !!value && typeof value.id === "string" && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.actionId === "string" &&
    /^[0-9a-f-]{36}$/i.test(value.actionId) && ["prepared", "submitted", "verified", "failed", "uncertain"].includes(value.type) &&
    Number.isFinite(Date.parse(value.occurredAt)) && !!value.details && typeof value.details === "object" && !Array.isArray(value.details);
}

/**
 * Durable JSON-file store for a single trusted Sofia process on a persistent local volume.
 * Exclusive file creation prevents duplicate reservations; this is NOT a multi-host/distributed lock.
 * For multiple processes or replicas, use a database implementation with unique constraints and transactions.
 */
export class FileFinancialActionStore implements FinancialActionStore {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private async ready(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); try { await chmod(this.directory, 0o700); } catch { /* platform may not support chmod */ } }
  private filename(ownerId: string, hash: string): string {
    if (!ownerId.trim() || !HASH.test(hash)) throw new Error("Invalid financial action storage key.");
    return path.join(this.directory, `${hash}.json`);
  }
  async find(ownerId: string, idempotencyHash: string): Promise<FinancialActionRecord | undefined> {
    await this.ready();
    try { const value: unknown = JSON.parse(await readFile(this.filename(ownerId, idempotencyHash), "utf8")); return validRecord(value, ownerId, idempotencyHash) ? value : undefined; }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw new Error("Financial action record could not be read or failed validation."); }
  }
  reserve(record: FinancialActionRecord): Promise<{ created: boolean; record: FinancialActionRecord }> {
    const operation = this.chain.then(async () => {
      await this.ready(); const target = this.filename(record.ownerId, record.idempotencyHash);
      if (!validRecord(record, record.ownerId, record.idempotencyHash)) throw new Error("Refusing to persist an invalid financial action record.");
      const handle = await open(target, "wx", 0o600).catch(async (error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return undefined;
        throw error;
      });
      if (!handle) { const existing = await this.find(record.ownerId, record.idempotencyHash); if (!existing) throw new Error("Existing financial action record is invalid."); return { created: false, record: existing }; }
      try { await handle.writeFile(JSON.stringify(record), "utf8"); await handle.sync(); } catch (error) { await handle.close(); try { await unlink(target); } catch { /* best effort cleanup */ } throw error; }
      await handle.close(); return { created: true, record };
    });
    this.chain = operation.then(() => undefined, () => undefined); return operation;
  }
  update(record: FinancialActionRecord): Promise<void> {
    const operation = this.chain.then(async () => {
      await this.ready(); const target = this.filename(record.ownerId, record.idempotencyHash);
      if (!validRecord(record, record.ownerId, record.idempotencyHash)) throw new Error("Refusing to persist an invalid financial action record.");
      const current = await this.find(record.ownerId, record.idempotencyHash);
      if (!current || current.id !== record.id) throw new Error("Cannot update an unreserved financial action.");
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temporary, target); }
      catch { try { await unlink(temporary); } catch { /* temporary file may not exist */ } throw new Error("Financial action record persistence failed."); }
    });
    this.chain = operation.then(() => undefined, () => undefined); return operation;
  }
}

/** Append-only local JSONL ledger. Protect its directory as sensitive financial audit data. */
export class FileFinancialLedger implements FinancialLedger {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly filename: string) {}
  append(event: FinancialActionEvent): Promise<void> {
    const operation = this.chain.then(async () => {
      if (!validEvent(event)) throw new Error("Refusing to append an invalid financial ledger event.");
      await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const handle = await open(this.filename, "a", 0o600);
      try { await handle.writeFile(JSON.stringify(event) + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
    });
    this.chain = operation.then(() => undefined, () => undefined); return operation;
  }
}