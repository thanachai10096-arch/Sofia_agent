/** Provider-neutral payment verification. Adapters must authenticate provider responses server-side.
 * Browser text, client claims, and unsigned callbacks are never authoritative payment evidence.
 */
export type PaymentProviderStatus = "succeeded" | "processing" | "failed";
export type PaymentVerificationStatus = PaymentProviderStatus | "unknown" | "mismatch";

export interface ExpectedPayment {
  orderReference: string;
  amountMinor: number;
  currency: string;
}

/** Returned only after the adapter has authenticated the provider response (API credentials or signed webhook). */
export interface AuthenticatedProviderPayment {
  authenticated: boolean;
  provider: string;
  providerPaymentId: string;
  orderReference: string;
  amountMinor: number;
  currency: string;
  status: PaymentProviderStatus;
  observedAt: string;
}

export interface PaymentVerificationAdapter {
  readonly provider: string;
  verify(expected: ExpectedPayment): Promise<AuthenticatedProviderPayment | null>;
}

export interface PaymentVerificationResult {
  status: PaymentVerificationStatus;
  verified: boolean;
  provider?: string;
  providerPaymentId?: string;
  orderReference: string;
  amountMinor: number;
  currency: string;
  observedAt?: string;
  reason: string;
}

function validExpected(expected: ExpectedPayment): boolean {
  return expected.orderReference.trim().length > 0 && Number.isSafeInteger(expected.amountMinor) &&
    expected.amountMinor >= 0 && /^[A-Z]{3}$/.test(expected.currency);
}

/** Returns unknown when no real provider adapter is configured; never infers payment from checkout-page text. */
export async function verifyPayment(
  expected: ExpectedPayment,
  adapter?: PaymentVerificationAdapter,
): Promise<PaymentVerificationResult> {
  if (!validExpected(expected)) throw new Error("Expected payment must include an order reference, non-negative integer minor-unit amount, and ISO currency code.");
  const base = { orderReference: expected.orderReference, amountMinor: expected.amountMinor, currency: expected.currency };
  if (!adapter) return { ...base, status: "unknown", verified: false, reason: "No payment provider adapter is configured." };
  const payment = await adapter.verify(expected);
  if (!payment || payment.authenticated !== true) {
    return { ...base, status: "unknown", verified: false, provider: adapter.provider, reason: "Provider response is missing or was not authenticated." };
  }
  const provider = payment.provider.trim();
  const identityMatches = provider.length > 0 && payment.provider === adapter.provider &&
    payment.orderReference === expected.orderReference && payment.amountMinor === expected.amountMinor &&
    payment.currency === expected.currency && Number.isSafeInteger(payment.amountMinor) &&
    payment.providerPaymentId.trim().length > 0 && Number.isFinite(Date.parse(payment.observedAt));
  if (!identityMatches) {
    return { ...base, status: "mismatch", verified: false, provider: provider || adapter.provider, reason: "Authenticated provider data does not match the expected order, amount, currency, or identity." };
  }
  return {
    ...base, status: payment.status, verified: payment.status === "succeeded",
    provider, providerPaymentId: payment.providerPaymentId, observedAt: payment.observedAt,
    reason: payment.status === "succeeded" ? "Payment provider authenticated a successful payment." :
      payment.status === "failed" ? "Payment provider authenticated a failed payment." :
        "Payment provider authenticated a payment that is still processing.",
  };
}
