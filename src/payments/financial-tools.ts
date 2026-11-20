import type { SofiaTool } from "../tools/types.js";
import type { FinancialActionDependencies } from "./financial-actions.js";
import { executeFinancialAction, reconcileFinancialAction } from "./financial-actions.js";

const stringField = (description: string) => ({ type: "string", description });

/**
 * Exposes the financial engine to Sofia through the normal tool gateway.
 * The host must inject owner-scoped approvals, durable stores, and a real provider adapter.
 * Payment execution is destructive + network and therefore requires the existing policy/approval path.
 */
export function createFinancialActionTools(dependencies: FinancialActionDependencies, authenticatedOwnerId: string): SofiaTool[] {
  if (!authenticatedOwnerId.trim()) throw new Error("An authenticated owner ID is required to expose financial tools.");
  return [
    {
      name: "finance.payment.execute",
      description: "Prepare and submit one exactly approved payment through the configured provider, then verify its result. Never treat a checkout click as proof of payment.",
      effects: ["network", "destructive"],
      inputSchema: {
        type: "object",
        properties: {
          orderReference: stringField("Merchant order reference."),
          amountMinor: { type: "integer", description: "Positive amount in currency minor units (THB uses satang)." },
          currency: { type: "string", description: "Uppercase ISO 4217 currency code." },
          idempotencyKey: stringField("Stable unique key for this exact payment intent; reuse it for retries."),
          approvalId: stringField("Approval ID bound to this owner, order, amount, and currency."),
        },
        required: ["orderReference", "amountMinor", "currency", "idempotencyKey", "approvalId"],
        additionalProperties: false,
      },
      async execute(input) {
        if (typeof input.orderReference !== "string" ||
            typeof input.amountMinor !== "number" || typeof input.currency !== "string" ||
            typeof input.idempotencyKey !== "string" || typeof input.approvalId !== "string") {
          throw new Error("Invalid financial payment tool input.");
        }
        return executeFinancialAction({
          ownerId: authenticatedOwnerId, orderReference: input.orderReference, amountMinor: input.amountMinor,
          currency: input.currency, idempotencyKey: input.idempotencyKey, approvalId: input.approvalId,
        }, dependencies);
      },
    },
    {
      name: "finance.payment.reconcile",
      description: "Read the configured provider status for an existing payment. This tool never creates or retries a charge.",
      effects: ["network"],
      inputSchema: {
        type: "object",
        properties: {
          idempotencyKey: stringField("Original payment idempotency key."),
        },
        required: ["idempotencyKey"],
        additionalProperties: false,
      },
      async execute(input) {
        if (typeof input.idempotencyKey !== "string") {
          throw new Error("Invalid financial reconciliation tool input.");
        }
        return reconcileFinancialAction({ ownerId: authenticatedOwnerId, idempotencyKey: input.idempotencyKey }, dependencies);
      },
    },
  ];
}
