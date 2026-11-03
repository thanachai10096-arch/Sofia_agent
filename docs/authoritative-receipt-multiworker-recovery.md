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

## 8. Authorization time-of-check/time-of-use boundary

A coordinator or executor read immediately before a side effect is still a read-then-act sequence. It narrows the race window but does not make approval revocation atomic with runtime mutation.

The production lifecycle adapter must therefore enforce the approval gate at the mutation boundary using the authoritative approval service. It must either:

- perform a transaction/conditional mutation that verifies the exact receipt ID, authenticated actor, skill, scope, policy revision, and approved status atomically with the lifecycle state change; or
- consume a short-lived, single-use authorization capability issued by the authoritative approval service, with atomic replay prevention and revocation semantics defined by that service.

A caller-provided boolean, cached binding, executor preflight result, or model-generated approval claim is insufficient. If the existing lifecycle/approval service cannot provide a mutation-boundary guarantee, automatic repair must remain disabled and the case must be sent for manual review. The executor's repeated revalidation is defense in depth, not a substitute for this atomic gate.

## 9. Required integration evidence before enablement

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

The following is an as-built review of the latest inspected PR head, not a target-state claim:

- `SqliteSelfImprovementCheckpointStore` now stores a monotonic per-scope revision, migrates existing checkpoint tables additively, returns the revision from `read`, and implements `compareAndSet` under `BEGIN IMMEDIATE`. Both the initial insert and later updates advance the revision.
- `ScopedSelfImprovement` uses revision CAS when the configured checkpoint adapter exposes it, reloads and recomputes after a conflict, and bounds retries. Adapters without CAS retain the legacy unconditional-write compatibility path and are not thereby safe for concurrent workers.
- Pending notifications now reject a conflicting receipt ID for an already-pending sequence and reject reuse of a pending receipt ID at another sequence.
- `createVerifiedCompletionHandler.recover` preflights the returned receipt array for contiguous ascending sequence numbers before replay. It still does not acquire a distributed scope lease.
- The checkpoint schema still has no lease owner, fencing token, or lease expiry.
- `src/api/entrypoint.ts` does not call `recover(scope)`; the inspected host does not currently compose an authoritative finalized-receipt listing adapter or authenticated tenant/project scope enumerator.
- The learning transaction store enforces scoped receipt/experience uniqueness, which supports idempotent learning writes, but it does not atomically couple the learning transaction with checkpoint advancement.

### Remaining concurrency and recovery boundaries

Revision CAS prevents stale checkpoint snapshots from overwriting newer pending-event state. It does not provide worker ownership, lease expiry, or fencing; it also cannot prove that a receipt listing adapter returned a complete stable snapshot across pagination. A worker may replay an already-recorded receipt after a crash before checkpoint advancement, so idempotency at the scoped receipt/experience boundary remains required.

The current implementation is therefore a meaningful cross-connection checkpoint-safety increment, **not a complete multi-worker recovery system**. Do not describe the whole recovery pipeline as production multi-worker safe, do not wire it into startup, and do not enable automatic production learning on the strength of CAS alone.

### Required next implementation increment

1. Add scope-bound lease claim/renew/release operations with store-clock expiry and fresh fencing tokens on takeover.
2. Require the active fencing token in checkpoint CAS, and reject stale-token writes and releases.
3. Route both live finalized notifications and crash recovery through the same lease/CAS discipline.
4. Make receipt listing use a stable high-water mark or snapshot and prove all pages were consumed before any replay begins.
5. Add deterministic two-process tests for lease races, expiry/takeover, stale-token rejection, pending-event preservation, and crash points around learning and checkpoint commits.
6. Verify the real authenticated scope resolver, authoritative receipt adapter, evidence resolver, lifecycle approval gate, and runtime registry before considering startup integration.

Until these changes and their tests exist, keep startup recovery unwired and automatic production learning disabled.


### 10. Checkpoint CAS increment — implemented, lease boundary remains open

The current branch adds a monotonic revision to verified_learning_checkpoints and an additive SQLite migration for existing databases. read returns the revision; compareAndSet(scope, expectedRevision, state) checks and increments it in one BEGIN IMMEDIATE transaction. A stale writer receives false and must reload rather than overwrite the newer pending-event set.

ScopedSelfImprovement uses this CAS path when the checkpoint adapter supports it. After a conflict it reloads and recomputes, with a bounded retry count. Replaying a receipt while recomputing relies on the existing learning transaction's unique (scope, receiptId) constraint. Older checkpoint adapters retain the legacy write fallback for compatibility and therefore do not gain cross-process CAS protection.

Regression coverage now includes two independent SQLite connections reading the same revision, one winning the CAS, the stale writer being rejected, pending notification preservation, and migration of a legacy checkpoint table.

This increment does not complete multi-worker safety. It prevents stale checkpoint overwrites but does not provide a scope lease/fencing token, does not make the receipt-store snapshot stable across pagination, and does not atomically couple learning transaction commit with checkpoint advancement. Recovery and live delivery must still be routed through a shared lease/CAS discipline before production enablement. The legacy write fallback must not be used by production multi-worker adapters.


### 11. Live-delivery side-effect race found during review

A further boundary exists in the current `ScopedSelfImprovement.process` ordering:

- It reads the checkpoint and validates pending identities.
- It calls `loop.recordVerifiedCompletion` for each contiguous notification.
- Only after those learning side effects does it attempt checkpoint `compareAndSet`.

Consequently, checkpoint CAS alone does **not** serialize the live learning side effect across independent workers. If two workers read the same cursor and concurrently receive different receipt IDs for the same next sequence, both can pass the pending-map checks and both can call `recordVerifiedCompletion` before either checkpoint CAS wins. The learning store's unique key is scoped by receipt ID, so two different IDs are not necessarily deduplicated. The losing worker may then reload after the winner advances the cursor and treat its sequence as already consumed. This can leave two distinct learning records associated with one authoritative sequence, even though the checkpoint has one winner.

This is a code-ordering risk identified by inspection; it is not evidence that the current CI failed.

Before describing live delivery as multi-worker safe, the next implementation must prevent side effects until delivery identity is durably arbitrated. Acceptable designs include:

1. A scope-bound distributed lease/fencing token shared by live delivery and recovery, held across identity validation, learning, and checkpoint advancement; or
2. A durable per-scope sequence reservation/claim committed with CAS before learning, with explicit pending/claimed/committed states, lease expiry/fencing for crash recovery, and idempotent replay after a crash.

A reservation-only CAS without ownership/expiry is insufficient: a crashed claimant could strand a sequence indefinitely. Do not merely move the existing CAS earlier without defining crash recovery and stale-worker fencing.

Required regression coverage:
- Two independent processes deliver different receipt IDs for the same next sequence; at most one identity may reach the learning loop.
- Two processes deliver the same receipt ID concurrently; learning remains idempotent and cursor advances once.
- Crash after reservation but before learning; a later worker safely takes over.
- Crash after learning but before cursor commit; replay does not duplicate the learning effect.
- Stale claimant resumes after takeover; it cannot learn, advance, or release the current claim.
- Live delivery and recovery racing on the same scope share the same arbitration mechanism.

Until this ordering/ownership gap is closed with deterministic multi-process tests, keep the recovery adapter unwired and automatic production learning disabled.
