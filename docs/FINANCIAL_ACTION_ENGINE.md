# Financial Action Engine

Sofia now has a provider-neutral payment execution foundation. It deliberately does not configure a payment provider or initiate any real charge by itself.

## Lifecycle

1. Validate owner, order reference, positive amount in minor units, currency, approval ID, and idempotency key.
2. Require an approval verifier to confirm that the approval belongs to this owner and the exact request fingerprint.
3. Reserve an owner-scoped, SHA-256-hashed idempotency key before calling the provider.
4. Submit through an injected provider adapter using the same idempotency identity.
5. Verify the result through the authenticated provider verification contract.
6. Append lifecycle events to the ledger. Only an authenticated provider success matching order, amount, currency, provider and payment ID becomes `succeeded`.

## Important behavior

- No configured provider returns `configured: false` and performs no submission.
- Replaying the same owner + key + request returns the existing record and never submits again.
- Reusing a key with a different request is rejected.
- A timeout or uncertain submission is recorded as `unknown`, not `failed`. Reconcile with the provider before any new attempt; do not generate a fresh key to blindly retry.
- Approval is distinct from provider authorization/capture. A successful checkout click or UI message is not payment evidence.
- Amounts are integer minor units (for THB, satang); currency is an uppercase ISO 4217 code.

## Production integration gates

`MemoryFinancialActionStore` and `MemoryFinancialLedger` are test/reference implementations only. A production adapter must provide durable, owner-scoped atomic reservation, immutable append-only ledger writes, and crash-safe state transitions. The store reservation and ledger append should share a database transaction or an outbox pattern. Provider adapter must implement the provider official create/verify APIs and signature rules, with secrets held server-side. Add provider sandbox integration tests, reconciliation for `unknown` and `processing`, refunds/disputes, merchant identity checks, and operational alerting before enabling real payments.

No payment provider is currently selected or configured. This module does not claim that Sofia can yet charge a card, transfer funds, or place a real order.