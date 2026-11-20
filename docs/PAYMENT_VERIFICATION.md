# Payment verification foundation

Sofia separates checkout-page evidence from authoritative payment-provider evidence.

## Current behavior

- `src/payments/verification.ts` defines the provider adapter contract and compares an authenticated provider result with the expected order reference, integer minor-unit amount, and ISO 4217 currency.
- A missing adapter or unauthenticated response returns `unknown`; a mismatch returns `mismatch`. Only an authenticated provider result with status `succeeded` sets `verified: true`.
- `src/payments/webhooks.ts` contains generic HMAC and event replay primitives. Its `t=<unix-seconds>,v1=<hex>` header and `<timestamp>.<rawBody>` signing payload are an internal example format, **not a claim of compatibility with Stripe, Opn, PayPal, or another provider**.

## Production integration requirements

1. Implement a provider-specific adapter using the provider's official API or exact webhook signature specification.
2. Read secrets only from server-side environment/secret storage. Never accept credentials, paid flags, or provider URLs from browser/client input.
3. Verify the signature against the exact raw request bytes before parsing or trusting the event.
4. Enforce timestamp tolerance and atomically deduplicate provider event IDs in a durable shared store. `MemoryWebhookReplayStore` is process-local and is only suitable for tests or local development.
5. Retrieve or validate the payment with the provider and compare merchant/account identity, order reference, amount in minor units, currency, and final provider status.
6. Treat pending, failed, refunded, disputed, and unknown states distinctly. A browser confirmation page is not payment settlement evidence.
7. Add provider-specific fixtures and integration tests using sandbox credentials before enabling live payment actions.

No payment provider is configured by this foundation alone. It does not create charges, transfer funds, or place orders.
