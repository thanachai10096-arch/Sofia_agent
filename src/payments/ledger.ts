import type { ExpectedPayment, PaymentVerificationResult } from "./verification.js";

export type FinancialOrderStatus = "prepared" | "order_submitted" | "payment_pending" | "paid" | "payment_failed" | "payment_review" | "cancelled";
export interface FinancialOrder extends ExpectedPayment {
  id: string; status: FinancialOrderStatus; version: number; createdAt: string; updatedAt: string;
  provider?: string; providerPaymentId?: string; paymentObservedAt?: string; lastPaymentReason?: string;
}
export interface FinancialOrderStore {
  get(id: string): Promise<FinancialOrder | null>;
  create(order: FinancialOrder): Promise<boolean>;
  compareAndSet(id: string, expectedVersion: number, next: FinancialOrder): Promise<boolean>;
}
export interface FinancialOrderInput extends ExpectedPayment { id: string; now?: string; }

function validateExpected(input: ExpectedPayment): void {
  if (!input.orderReference.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error("Order requires a reference, positive integer minor-unit amount, and uppercase ISO currency code.");
  }
}

/** Minimal in-memory store for tests and single-process development; production must inject a durable atomic store. */
export class MemoryFinancialOrderStore implements FinancialOrderStore {
  private readonly orders = new Map<string, FinancialOrder>();
  async get(id: string): Promise<FinancialOrder | null> { const order = this.orders.get(id); return order ? { ...order } : null; }
  async create(order: FinancialOrder): Promise<boolean> { if (this.orders.has(order.id)) return false; this.orders.set(order.id, { ...order }); return true; }
  async compareAndSet(id: string, expectedVersion: number, next: FinancialOrder): Promise<boolean> {
    const current = this.orders.get(id); if (!current || current.version !== expectedVersion || next.id !== id || next.version !== expectedVersion + 1) return false;
    this.orders.set(id, { ...next }); return true;
  }
}

export class FinancialActionEngine {
  constructor(private readonly store: FinancialOrderStore, private readonly now: () => string = () => new Date().toISOString()) {}

  async prepare(input: FinancialOrderInput): Promise<FinancialOrder> {
    validateExpected(input);
    if (!input.id.trim()) throw new Error("Order ID is required.");
    const timestamp = input.now ?? this.now();
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Order timestamp must be a valid ISO date.");
    const order: FinancialOrder = { id: input.id, orderReference: input.orderReference, amountMinor: input.amountMinor, currency: input.currency, status: "prepared", version: 1, createdAt: timestamp, updatedAt: timestamp };
    if (!await this.store.create(order)) throw new Error("Order ID already exists; refusing duplicate preparation.");
    return order;
  }

  async markOrderSubmitted(id: string): Promise<FinancialOrder> {
    const current = await this.requireOrder(id);
    if (current.status !== "prepared") throw new Error("Only a prepared order can be marked submitted.");
    return this.update(current, { ...current, status: "order_submitted" });
  }

  /** Records verified provider evidence only. This method does not initiate or capture a payment. */
  async recordPaymentVerification(id: string, result: PaymentVerificationResult): Promise<FinancialOrder> {
    const current = await this.requireOrder(id);
    if (current.status !== "order_submitted" && current.status !== "payment_pending" && current.status !== "payment_review" && current.status !== "payment_failed") {
      throw new Error("Payment evidence can only be reconciled after order submission and before cancellation or fulfillment.");
    }
    if (result.orderReference !== current.orderReference || result.amountMinor !== current.amountMinor || result.currency !== current.currency) {
      throw new Error("Payment evidence does not match the prepared order.");
    }
    const nextStatus = result.status === "succeeded" && result.verified ? "paid" :
      result.status === "processing" ? "payment_pending" :
        result.status === "failed" ? "payment_failed" : "payment_review";
    const next: FinancialOrder = { ...current, status: nextStatus, lastPaymentReason: result.reason };
    if (result.provider) next.provider = result.provider;
    if (result.providerPaymentId) next.providerPaymentId = result.providerPaymentId;
    if (result.observedAt) next.paymentObservedAt = result.observedAt;
    return this.update(current, next);
  }

  async cancel(id: string): Promise<FinancialOrder> {
    const current = await this.requireOrder(id);
    if (current.status === "paid" || current.status === "cancelled") throw new Error("Paid or already cancelled orders cannot be cancelled by this transition.");
    return this.update(current, { ...current, status: "cancelled" });
  }

  private async requireOrder(id: string): Promise<FinancialOrder> { const order = await this.store.get(id); if (!order) throw new Error("Financial order not found."); return order; }
  private async update(current: FinancialOrder, next: FinancialOrder): Promise<FinancialOrder> {
    const updated: FinancialOrder = { ...next, version: current.version + 1, updatedAt: this.now() };
    if (!await this.store.compareAndSet(current.id, current.version, updated)) throw new Error("Financial order changed concurrently; reload before retrying.");
    return updated;
  }
}
