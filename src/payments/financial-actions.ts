import { createHash, randomUUID } from "node:crypto";
import { verifyPayment, type ExpectedPayment, type PaymentVerificationAdapter, type PaymentVerificationResult } from "./verification.js";

export type FinancialActionStatus = "submitting" | "processing" | "succeeded" | "failed" | "unknown";
export interface FinancialActionRequest extends ExpectedPayment { ownerId: string; idempotencyKey: string; approvalId: string; }
export interface FinancialActionRecord {
  readonly id: string; readonly ownerId: string; readonly idempotencyHash: string; readonly requestFingerprint: string;
  readonly orderReference: string; readonly amountMinor: number; readonly currency: string;
  readonly status: FinancialActionStatus; readonly createdAt: string; readonly updatedAt: string;
  readonly approvalId: string; readonly provider?: string; readonly providerPaymentId?: string; readonly reason: string;
}
export interface FinancialActionEvent {
  readonly id: string; readonly actionId: string; readonly type: "prepared" | "submitted" | "verified" | "failed" | "uncertain";
  readonly occurredAt: string; readonly details: Readonly<Record<string, string | number | boolean>>;
}
export interface FinancialActionStore {
  find(ownerId: string, idempotencyHash: string): Promise<FinancialActionRecord | undefined>;
  reserve(record: FinancialActionRecord): Promise<{ created: boolean; record: FinancialActionRecord }>;
  update(record: FinancialActionRecord): Promise<void>;
}
export interface FinancialLedger { append(event: FinancialActionEvent): Promise<void>; }
export interface FinancialApprovalVerifier { verify(input: { ownerId: string; approvalId: string; requestFingerprint: string }): Promise<boolean>; }
export interface FinancialPaymentProvider extends PaymentVerificationAdapter {
  createPayment(input: ExpectedPayment & { idempotencyKey: string; metadata: Readonly<Record<string, string>> }): Promise<void>;
}
export interface FinancialActionDependencies {
  store: FinancialActionStore; ledger: FinancialLedger; approvals: FinancialApprovalVerifier; provider?: FinancialPaymentProvider;
  now?: () => Date;
}
export interface FinancialActionResult { record?: FinancialActionRecord; verification?: PaymentVerificationResult; replayed: boolean; configured: boolean; }

function fingerprint(request: FinancialActionRequest): string {
  return createHash("sha256").update(JSON.stringify({ ownerId: request.ownerId, orderReference: request.orderReference, amountMinor: request.amountMinor, currency: request.currency })).digest("hex");
}
function hashKey(ownerId: string, key: string): string { return createHash("sha256").update(ownerId + ":" + key).digest("hex"); }
function validate(request: FinancialActionRequest): void {
  if (!request.ownerId.trim() || !request.idempotencyKey.trim() || !request.approvalId.trim() || !request.orderReference.trim() ||
      !Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0 || !/^[A-Z]{3}$/.test(request.currency)) {
    throw new Error("Financial action requires owner, approval, idempotency key, order reference, positive minor-unit amount, and ISO currency.");
  }
}

/**
 * Executes one approved payment intent. A timeout after submission is recorded as unknown,
 * never as failed: callers must reconcile with the provider before retrying with a new key.
 * Stores and ledger must be durable and atomic in production; memory implementations are test-only.
 */
export async function executeFinancialAction(request: FinancialActionRequest, deps: FinancialActionDependencies): Promise<FinancialActionResult> {
  validate(request);
  if (!deps.provider) return { replayed: false, configured: false };
  const requestFingerprint = fingerprint(request);
  const idempotencyHash = hashKey(request.ownerId, request.idempotencyKey);
  const existing = await deps.store.find(request.ownerId, idempotencyHash);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) throw new Error("idempotency_key_reused: key is already bound to a different financial action.");
    return { record: existing, replayed: true, configured: true };
  }
  if (!(await deps.approvals.verify({ ownerId: request.ownerId, approvalId: request.approvalId, requestFingerprint }))) {
    throw new Error("Financial action approval is missing, expired, or does not match this exact transaction.");
  }
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const initial: FinancialActionRecord = { id: randomUUID(), ownerId: request.ownerId, idempotencyHash, requestFingerprint,
    orderReference: request.orderReference, amountMinor: request.amountMinor, currency: request.currency, status: "submitting",
    createdAt: now, updatedAt: now, approvalId: request.approvalId, provider: deps.provider.provider, reason: "Payment submission started." };
  const reservation = await deps.store.reserve(initial);
  if (!reservation.created) {
    if (reservation.record.requestFingerprint !== requestFingerprint) throw new Error("idempotency_key_reused: key is already bound to a different financial action.");
    return { record: reservation.record, replayed: true, configured: true };
  }
  await deps.ledger.append({ id: randomUUID(), actionId: initial.id, type: "prepared", occurredAt: now, details: { orderReference: request.orderReference, amountMinor: request.amountMinor, currency: request.currency } });
  try {
    await deps.provider.createPayment({ orderReference: request.orderReference, amountMinor: request.amountMinor, currency: request.currency,
      idempotencyKey: idempotencyHash, metadata: { ownerId: request.ownerId, financialActionId: initial.id } });
  } catch {
    const uncertain: FinancialActionRecord = { ...initial, status: "unknown", updatedAt: (deps.now ?? (() => new Date()))().toISOString(), reason: "Provider submission outcome is uncertain; reconcile before any new attempt." };
    await deps.store.update(uncertain);
    await deps.ledger.append({ id: randomUUID(), actionId: initial.id, type: "uncertain", occurredAt: uncertain.updatedAt, details: { reason: "provider_submission_outcome_unknown" } });
    return { record: uncertain, replayed: false, configured: true };
  }
  await deps.ledger.append({ id: randomUUID(), actionId: initial.id, type: "submitted", occurredAt: (deps.now ?? (() => new Date()))().toISOString(), details: { provider: deps.provider.provider } });
  const expected = { orderReference: request.orderReference, amountMinor: request.amountMinor, currency: request.currency };
  let verification: PaymentVerificationResult;
  try { verification = await verifyPayment(expected, deps.provider); }
  catch { verification = { ...expected, status: "unknown", verified: false, provider: deps.provider.provider, reason: "Provider verification failed; reconcile before retrying." }; }
  const status: FinancialActionStatus = verification.verified ? "succeeded" : verification.status === "failed" ? "failed" : verification.status === "processing" ? "processing" : "unknown";
  const updated: FinancialActionRecord = { ...initial, status, updatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    ...(verification.providerPaymentId ? { providerPaymentId: verification.providerPaymentId } : {}), reason: verification.reason };
  await deps.store.update(updated);
  await deps.ledger.append({ id: randomUUID(), actionId: initial.id, type: verification.verified ? "verified" : status === "failed" ? "failed" : "uncertain",
    occurredAt: updated.updatedAt, details: { status, verified: verification.verified, reason: verification.reason } });
  return { record: updated, verification, replayed: false, configured: true };
}

/**
 * Re-checks a previously submitted `unknown`, `processing`, or interrupted `submitting` action.
 * This is read/verify-only: it never submits or captures a second payment.
 */
export async function reconcileFinancialAction(input: { ownerId: string; idempotencyKey: string }, deps: FinancialActionDependencies): Promise<FinancialActionResult> {
  if (!input.ownerId.trim() || !input.idempotencyKey.trim()) throw new Error("Owner and idempotency key are required for reconciliation.");
  const existing = await deps.store.find(input.ownerId, hashKey(input.ownerId, input.idempotencyKey));
  if (!existing) throw new Error("Financial action was not found.");
  if (existing.status === "succeeded" || existing.status === "failed") return { record: existing, replayed: true, configured: Boolean(deps.provider) };
  if (!deps.provider) return { record: existing, replayed: true, configured: false };
  if (existing.provider && existing.provider !== deps.provider.provider) throw new Error("Configured provider does not match the original financial action.");
  const expected = { orderReference: existing.orderReference, amountMinor: existing.amountMinor, currency: existing.currency };
  let verification: PaymentVerificationResult;
  try { verification = await verifyPayment(expected, deps.provider); }
  catch { verification = { ...expected, status: "unknown", verified: false, provider: deps.provider.provider, reason: "Provider reconciliation failed." }; }
  const status: FinancialActionStatus = verification.verified ? "succeeded" : verification.status === "failed" ? "failed" : verification.status === "processing" ? "processing" : "unknown";
  const updated: FinancialActionRecord = { ...existing, status, updatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    ...(verification.providerPaymentId ? { providerPaymentId: verification.providerPaymentId } : {}), reason: verification.reason };
  await deps.store.update(updated);
  await deps.ledger.append({ id: randomUUID(), actionId: existing.id, type: verification.verified ? "verified" : status === "failed" ? "failed" : "uncertain",
    occurredAt: updated.updatedAt, details: { status, verified: verification.verified, reconciliation: true, reason: verification.reason } });
  return { record: updated, verification, replayed: true, configured: true };
}
/** In-memory reference stores are deliberately process-local and must not be used for production payments. */
export class MemoryFinancialActionStore implements FinancialActionStore {
  private readonly records = new Map<string, FinancialActionRecord>();
  private key(ownerId: string, hash: string): string { return ownerId + ":" + hash; }
  async find(ownerId: string, idempotencyHash: string): Promise<FinancialActionRecord | undefined> { return this.records.get(this.key(ownerId, idempotencyHash)); }
  async reserve(record: FinancialActionRecord): Promise<{ created: boolean; record: FinancialActionRecord }> {
    const key = this.key(record.ownerId, record.idempotencyHash), existing = this.records.get(key);
    if (existing) return { created: false, record: existing };
    this.records.set(key, record); return { created: true, record };
  }
  async update(record: FinancialActionRecord): Promise<void> {
    const key = this.key(record.ownerId, record.idempotencyHash);
    if (!this.records.has(key)) throw new Error("Cannot update an unreserved financial action.");
    this.records.set(key, record);
  }
}
export class MemoryFinancialLedger implements FinancialLedger {
  private readonly entries: FinancialActionEvent[] = [];
  async append(event: FinancialActionEvent): Promise<void> { this.entries.push(Object.freeze({ ...event, details: Object.freeze({ ...event.details }) })); }
  snapshot(): readonly FinancialActionEvent[] { return this.entries.slice(); }
}