# Autonomy observability

The observability module provides a tenant-scoped, append-only event ledger and
small aggregate summary for autonomy operations.

## Captured data

Events use a fixed event taxonomy and outcome enum. Optional measurements cover
duration, cycles, steps, tool calls and estimated spend. A host may attach one
opaque subject identifier and an idempotency key.

Do not put prompts, research findings, tool arguments/results, credentials,
personal data, arbitrary labels or model-generated free-form text in telemetry.
Resolve `scope` from the authenticated principal in trusted host code. Never
accept tenant scope or idempotency keys from model-generated content.

## Integration contract

Construct `AutonomyObservability` with an `AutonomyEventStore`. The included
`InMemoryAutonomyEventStore` is for tests and single-process development only.
Production hosts must provide a durable transactional store with atomic
per-scope transactions, uniqueness for idempotency keys, tenant isolation,
retention controls and bounded reads. This change does not connect telemetry to
the API, worker, PostgreSQL, or a production database.

Use stable event keys, for example `job:<job-id>:completed` or
`research:<job-id>:cycle:<cycle>:completed`. Reusing a key with different
measurements is rejected. Query limits are capped at 500 events per call.
