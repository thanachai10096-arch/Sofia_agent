# API Run Durability and Recovery

This document describes the guarantees and current limits of the optional API run-record store.

## Current behavior

- `FileRunRecordStore` writes each record to a unique temporary file and atomically renames it to the final JSON path.
- Run record directories are created with owner-only permissions; record files are written with owner-only permissions.
- Writes and removals for the same run ID are serialized across `FileRunRecordStore` instances inside one Node.js process.
- The in-memory API server remains authoritative while that process is running.
- On API startup, persisted `queued` and `running` records are marked `failed` with a server-restart interruption message. They are not automatically resumed because replaying partially completed external side effects could duplicate actions or model charges.
- Async-run idempotency metadata is stored with the run record. The raw client idempotency key is not stored. After restart, a matching key and request fingerprint return the existing run; reusing the key with a different request returns a conflict.
- Records are owner-scoped by the hash of the authenticated API key. Read and cancel endpoints verify the owner before returning a record or changing its state.

## Guarantees that are not provided

- The per-record operation queue is process-local. It does not coordinate separate Node.js processes, containers, or machines.
- The file store is not a transactional shared multi-worker idempotency registry. Two API workers can independently accept the same idempotency key before either sees the other's record.
- File writes are best-effort in the current API integration. Persistence errors are swallowed by the store and do not currently prevent a run from starting or an accepted response from being returned. Operators must not treat HTTP 202 as proof that a durable record reached disk.
- Atomic rename protects against partially written JSON files but does not by itself provide cross-process compare-and-swap, durable reservation, fsync-backed power-loss guarantees, or exactly-once external side effects.
- Interrupted runs are marked failed rather than resumed. A new idempotency key is required to request a fresh attempt after an interrupted run.
- The in-memory idempotency map and concurrency counter are per API process. They do not enforce global concurrency or idempotency limits across workers.

## Deployment guidance

- Use one API process with a private persistent state directory when relying on `FileRunRecordStore` today.
- Do not mount one run-record directory as shared writable storage across multiple API workers and assume it provides distributed idempotency.
- For multi-worker or multi-region deployment, use a transactional backend that supports atomic reservation keyed by (authenticated principal, idempotency key), request-fingerprint comparison, owner-scoped run records, leases/heartbeats, and durable state transitions.
- Before enabling automatic resume, introduce step-level idempotency/outbox semantics for external side effects and provider settlement. A run snapshot alone is not proof that replay is safe.
- Monitor persistence errors and verify restart behavior in the actual deployment environment. Do not advertise exactly-once execution; the practical target is deduplicated request acceptance plus idempotent/settled side effects.

## Required release checks

- Verify the persistent state directory survives deployment replacement and is not shared by unrelated tenants.
- Restart the API with queued/running/completed records and confirm the documented recovery behavior.
- Retry an async request with the same idempotency key and same payload; confirm the original run is returned.
- Retry with the same key and a changed payload; confirm HTTP 409.
- Run cross-process contention tests against the actual chosen backend before deploying more than one API worker.
- Inject disk-full/permission/rename failures and confirm operational alerts are raised. The current file store is best-effort, so this check remains a release blocker for deployments that require durable acceptance.
