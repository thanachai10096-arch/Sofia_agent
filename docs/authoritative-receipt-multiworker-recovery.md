# Authoritative Receipt and Multi-worker Recovery Contract

Status: design contract only. This document does not claim that a production receipt adapter, distributed lease, or startup wiring exists.

## 1. Authoritative receipt source

The recovery adapter must read from the same durable system that records finalized, trusted verification receipts. It must not derive receipts from:

- Brain callback payloads;
- process-local counters or queues;
- the learning SQLite database;
- API run records that do not contain the trusted verifier's finalized evidence;
- model-generated summaries or candidate metadata.

A receipt is eligible only after the verifier has durably committed its final outcome and the evidence references needed to revalidate that outcome.

## 2. Scope and identity

Every read, append, sequence allocation, and recovery operation is bound to the authenticated tuple:

`(tenantId, principalId, projectId)`

The host resolves this tuple from authenticated server context. It must never accept a model-supplied or message-supplied scope as authority. A receipt from another tuple must be indistinguishable from absent data to the caller and must never enter a learning transaction.

Receipt IDs are unique within the authoritative scope. The store enforces uniqueness atomically, including across independent processes and connections.

## 3. Sequence allocation and listing

The authoritative store allocates a monotonically increasing sequence per scope in the same transaction that finalizes the receipt. Sequence allocation must be atomic across workers.

The listing API must provide a stable, complete, ascending view of all retained receipts after an exclusive cursor. If pagination is used, the adapter must consume every page from one consistent snapshot (or use an equivalent immutable high-water mark) before returning the batch. It must not silently truncate a page or sort malformed data into apparent validity.

For a checkpoint at sequence N, the next replayable receipt must be N+1. A missing sequence is a recovery blocker, not permission to skip forward. Retention must preserve enough tombstone/high-water information to distinguish a missing receipt from a legitimate end of stream. If the store cannot prove continuity, recovery stops for operator review.

## 4. Multi-worker claim and fencing

A process-local promise queue is not a distributed lock. A production recovery adapter must provide an atomic, scope-bound lease claim with:

- a unique, unguessable fencing token for each claim attempt;
- a bounded lease expiry evaluated by the store's clock;
- owner-checked heartbeat and release;
- atomic replacement of an expired lease with a new token;
- rejection of heartbeat, checkpoint, or finalization writes from stale tokens.

A worker that loses its lease must stop before making any further checkpoint or cursor mutation. A stale worker must not be able to overwrite a newer worker's progress, even if it resumes after a long pause.

## 5. Checkpoint commit protocol

The recovery cursor and pending notification state must be durable and scope-isolated. Cursor advancement is permitted only after the corresponding receipt has completed its idempotent learning transaction successfully.

The checkpoint adapter must expose a compare-and-set or fenced transaction that checks the expected previous cursor and current lease token in the same atomic commit. A plain read followed by an unconditional write is insufficient for multi-process operation.

The learning transaction must enforce unique `(scope, receiptId)` insertion. If a worker crashes after recording the experience but before checkpoint commit, a new worker may safely retry the receipt and then advance the cursor after confirming the existing scoped experience. If learning fails, the cursor remains unchanged.

## 6. Recovery algorithm

1. Resolve authenticated scope from trusted host context.
2. Atomically claim the scope's recovery lease and obtain a fencing token.
3. Read the durable checkpoint and a stable authoritative receipt snapshot.
4. Validate the entire returned batch before replay: scope, receipt identity, sequence continuity, and required fields.
5. Reject the whole batch before replay if any sequence is missing, duplicated, out of order, malformed, or outside the requested scope.
6. Process receipts in ascending sequence order. Each receipt is idempotent by scoped receipt ID.
7. After each successful receipt, atomically advance the checkpoint using the expected prior cursor and fencing token.
8. Heartbeat during long work. Stop immediately if lease ownership is lost.
9. Release the lease in a finally path, but never let a stale release clear a newer claim.
10. Record redacted operational outcomes; do not log task text, credentials, evidence contents, or raw provider responses.

A batch-level preflight prevents known gaps from causing partial replay. Per-receipt checkpoint commits allow safe resumption after a crash during a valid contiguous batch.

## 7. Startup and operational safety

Startup recovery must be opt-in until the host has supplied and integration-tested all authoritative adapters. It must run only after authenticated scope enumeration is available; it must not invent a global scope or enumerate tenants without authorization.

Recovery must be bounded and observable. A failure must leave the cursor unchanged for the failed receipt, emit a redacted diagnostic, and allow a later retry. It must not block Sofia's normal API startup unless an explicit deployment policy requires fail-closed startup.

No production learning activation is permitted merely because receipt replay succeeded. Existing policy assessment, trusted evidence revalidation, regression execution, lifecycle approval, and runtime postcondition checks remain mandatory.

## 8. Required integration evidence before enablement

- Real adapter contract tests against the authoritative receipt store.
- Two independent processes racing to claim the same scope: exactly one current fencing token.
- Expired-lease takeover, followed by proof that the stale worker cannot heartbeat, commit a cursor, or release the new lease.
- Concurrent receipt finalization proving unique, gap-free sequence allocation per scope.
- Pagination/snapshot tests under concurrent appends.
- Crash injection before learning, after learning, and before/after checkpoint commit.
- Duplicate receipt replay proving no duplicate experience or lifecycle registration.
- Gap, duplicate, reordered, cross-scope, corrupt, and retention-boundary negative tests.
- Startup integration tests using the actual authenticated scope resolver and actual stores.
- CI and security checks run against the exact PR head being reviewed.

Until all evidence exists, keep the recovery adapter unwired and automatic production learning disabled.

## 9. Verified implementation boundary at PR review

The following is an as-built review of the current PR head, not a target-state claim:

- `SqliteSelfImprovementCheckpointStore` provides durable, scope-keyed SQLite reads and atomic single-row writes using `BEGIN IMMEDIATE`. Its current `write` operation is an unconditional upsert; it does not compare an expected checkpoint version or verify a fencing token.
- `ScopedSelfImprovement` uses a promise tail, which serializes notifications only inside one JavaScript object/process. It is not a cross-process lock.
- `createVerifiedCompletionHandler.recover` preflights the returned receipt array for contiguous ascending sequence numbers before replay. It then delegates to the same process-local worker and does not acquire a distributed scope lease.
- The checkpoint schema currently has no lease owner, fencing token, lease expiry, or monotonic checkpoint version.
- `src/api/entrypoint.ts` does not call `recover(scope)`; the inspected host does not currently compose an authoritative finalized-receipt listing adapter or authenticated tenant/project scope enumerator.
- The learning transaction store enforces scoped receipt/experience uniqueness, which is useful for idempotent learning writes, but it does not make checkpoint read-modify-write atomic with the learning transaction or with another process.

### Concrete race this leaves open

Two independent workers can both read the same checkpoint and process overlapping notifications. Their learning writes may deduplicate by scoped receipt ID, but their later unconditional checkpoint upserts can race. A stale writer can replace newer pending-notification metadata, and there is no fencing token that prevents a worker whose lease should have expired from writing. Atomic SQLite upsert alone does not solve this read-modify-write race.

Therefore the existing implementation is durable and restart-readable, but it is **not yet proven safe for concurrent multi-process recovery**. Do not describe it as multi-worker safe, do not wire it into production startup, and do not enable automatic production learning on the strength of these primitives alone.

### Required next implementation increment

1. Add a checkpoint revision/version that increments on every mutation, including pending-only writes.
2. Add a SQLite compare-and-set operation that checks expected revision and the active fencing token in the same transaction as the checkpoint update.
3. Add scope-bound lease claim/renew/release operations with store-clock expiry and fresh fencing tokens on takeover.
4. Route both live finalized notifications and crash recovery through the same lease/CAS discipline; protecting recovery alone is insufficient if live notifications can race with it.
5. On CAS conflict, reload and recompute from the new state; never retry a stale serialized snapshot blindly.
6. Make receipt listing use a stable high-water mark or snapshot and prove all pages were consumed before any replay begins.
7. Add deterministic two-connection and two-process tests that force stale-write interleavings, lease expiry/takeover, stale-token rejection, pending-event preservation, and crash points around learning and checkpoint commits.

Until these changes and their tests exist, the safe action is to leave startup recovery unwired and report the multi-worker capability as pending.
