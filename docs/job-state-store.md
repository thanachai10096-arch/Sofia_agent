# Durable Job State Store Contract

Sofia's `DurableJobRuntime` accepts an injected `JobStateStore`. The default remains `FileJobStateStore`, preserving existing local installations. A custom implementation can be passed as the fourth constructor argument.

## Required guarantees

A store used by more than one runtime process must implement these operations with database-level transactions or equivalent atomic compare-and-set behavior:

- **createIfAbsent:** insert the job and its idempotency key atomically. Enforce uniqueness on `(ownerKeyId, idempotencyKey)` whenever the key is present. Return the existing canonical record when another worker already inserted it.
- **claim:** atomically transition an eligible queued job, or a running job with an expired lease, to running and install a fresh unpredictable lease-owner token and expiry.
- **heartbeat:** extend a lease only when the job is still running, the token matches, and the previous lease has not expired.
- **save:** reject writes from stale lease tokens and writes after lease expiry; do not allow a late worker to overwrite a newer worker's state.
- **cancel:** atomically persist cancellation so a worker cannot subsequently overwrite it with a non-terminal state.
- **markInterruptedIfExpired:** only mark a running job interrupted after its lease is expired.
- **get/list:** return the persisted canonical records; public API redaction remains the runtime's responsibility.

For SQL implementations, use a partial unique index for non-null idempotency keys and conditional `UPDATE ... RETURNING` statements for lease claims/heartbeats. Keep record JSON and indexed ownership/idempotency/lease columns in the same transaction.

## Deployment boundaries

- `FileJobStateStore` coordinates processes only when they share a compatible local filesystem. It is not a multi-host store.
- An injected SQL store is not automatically a distributed worker queue. Multi-host execution also needs workers to poll/claim queued jobs from the shared store, plus graceful shutdown and bounded concurrency. That worker-polling loop is not yet implemented by this change.
- SQLite can provide transactional coordination for processes sharing one host and a supported local filesystem; do not treat a SQLite file on a network volume as a safe multi-host database.
- A PostgreSQL-backed implementation is the appropriate next adapter for independent hosts. It must use database transactions for the guarantees above.
- Idempotent job creation prevents duplicate job records for a repeated key. It does not make arbitrary external actions exactly-once; tools that perform external side effects still need their own idempotency keys or reconciliation.

## Compatibility

The existing three-argument `DurableJobRuntime` constructor remains unchanged. The optional fourth argument allows a custom store to be injected without changing existing deployments.

## Multi-host worker readiness: remaining runtime contract

The store interface is only the persistence boundary; the current runtime still starts execution in the process that accepts `submit()`. Before a separate worker process can safely consume queued jobs, the runtime must persist a versioned, serializable execution payload with each job. At minimum that payload must preserve the BrainRunInput fields that affect execution:

- `task`, `modelRouteId`, `context`, and `acceptanceCriteria`;
- `understanding`, `plan`, and `rollbackOnFailure` when supplied;
- the authenticated principal/owner association (never a caller-controlled replacement for it).

The payload must exclude live objects such as `AbortSignal`, functions, runtime instances, and in-memory handles. It must be validated and redacted before persistence, and older records without a payload must remain readable with an explicit legacy/recovery path. Do not reconstruct a worker's input from `task` alone: that silently drops context and acceptance criteria.

A separate worker service can then repeatedly list candidate queued/expired jobs, call the store's atomic `claim`, and execute only the returned claimed record. Listing is advisory; the claim is the ownership decision. Each worker needs bounded concurrency, lease heartbeats, cancellation propagation, and graceful shutdown. A worker must stop if heartbeat/fenced save fails. Polling intervals should be configurable and jittered to avoid synchronized database load.

The first PostgreSQL adapter should be introduced only after the execution-payload contract and worker lifecycle are implemented and tested. Adding a database dependency before those pieces exist would provide shared storage without providing distributed execution. Integration tests must use multiple runtime/worker instances against one real database and cover concurrent idempotent submission, competing claims, lease expiry/reclaim, stale-worker writes, cancellation races, and process restart recovery.

