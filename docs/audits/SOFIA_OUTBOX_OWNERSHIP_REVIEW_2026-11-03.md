# Follow-up Security Review — Outbox Ownership and Worker Concurrency
Date: 2026-11-03

## Scope

Reviewed the audit branch `audit/2026-11-runtime-integration-review` after commit `cc5e6a313398202febb4973727a46738970d1fb6`. This is a source review and additive hardening note; it does not authorize migration, merge, deployment, or production changes.

## Confirmed boundaries

- The public `POST /v1/jobs` route derives `ownerKeyId` from the authenticated API key identity. It does not accept `notificationChannelId` from request input.
- The Discord durable-job adapter derives its owner principal from the Discord author ID and takes its notification channel from the inbound message metadata, after the transport's configured user and channel allowlists.
- Terminal PostgreSQL job persistence inserts the outbox row from the successfully updated job row, copying its owner and persisted notification destination. The caller cannot choose a different destination in that transaction.
- Outbox claim uses PostgreSQL `FOR UPDATE SKIP LOCKED`; lease renewal, ACK, and retry are fenced by message ID, processing status, worker token, and an unexpired lease.

## Finding fixed

The standalone `PostgresOutboxStore.enqueue()` path previously inserted the caller-supplied owner and destination directly. Unlike terminal persistence, it did not prove that either value matched the referenced job. A trusted-but-misconfigured internal caller could therefore create an outbox row with a mismatched tenant label or notification destination.

Fix:
- Changed enqueue to `INSERT ... SELECT` from `sofia_agent_jobs`.
- It now inserts only if the job ID exists, the supplied owner matches the persisted job owner (including null-safe comparison), and the supplied destination exactly matches the job's persisted `notification_channel_id`.
- The inserted owner is selected from the job row, not copied from caller input.
- Added source-level assertions for the owner predicate, destination predicate, and row-derived owner.

This is additive at the code level and does not change the public API. The query contract has not been exercised against a live PostgreSQL instance.

## Remaining security/reliability gates

1. **Discord channel privacy:** user and channel allowlists are currently independent sets. An allowed user can submit in an allowed channel, and results are posted back to that channel. In a channel shared by multiple people, task results may be visible to other channel members. Numeric channel-ID validation and allowlists do not establish exclusive ownership. Before multi-tenant/general availability, choose and enforce an explicit policy: private DM delivery, per-owner channel binding, or an explicit shared-channel consent/visibility model. Do not silently change existing behavior without reviewing the intended product contract.
2. **Discord owner-scoped operations:** the gateway currently performs a read/check of `ownerKeyId` before calling some unscoped runtime methods (`resume`, `cancel`). IDs are random and ownership is immutable through the store's save predicate, but an atomic owner-scoped resume/cancel operation at the storage boundary is the stronger contract. This remains follow-up work.
3. **Outbox concurrency:** source inspection confirms `SKIP LOCKED` and lease fencing, but existing tests are SQL-contract/fake-store tests. A real two-connection PostgreSQL test must prove: two workers cannot claim the same live row; an expired processing lease can be reclaimed; the old worker cannot ACK or retry after the new worker takes ownership; and a crash after provider acceptance is handled as at-least-once delivery.
4. **Outbox history retention:** the migration currently uses `ON DELETE CASCADE` from jobs to outbox rows. Any future job-retention/deletion operation would also delete delivery evidence. No job deletion path was found in this scoped review, but retention policy must preserve audit/dead-letter evidence before adding deletion or cleanup.
5. **Deployment wiring:** PostgreSQL stores, migration, outbox dispatcher, and worker remain host-injected scaffolding. Vercel runtime is not connected to a shared database or managed daemon in this branch.

## Verification status

- Branch compare and source reads completed.
- Changed files: `src/brain/postgres-outbox-store.ts`, `src/brain/postgres-outbox-store.test.ts`.
- Added SQL-contract assertions; tests were not executed.
- No local build, typecheck, unit test, live PostgreSQL test, migration, Vercel deployment, merge, or production change was performed.


## Additional Discord Gateway path review

Inspected `workers/discord-gateway/daemon/worker.mjs` directly:

- The daemon filters inbound messages against separate `DISCORD_ALLOWED_USER_IDS` and `DISCORD_ALLOWED_CHANNEL_IDS` sets.
- It submits each message directly to `/api/v1/agent/runs`, using an idempotency key derived from the Discord message ID. It does not submit through the durable Job Runtime / PostgreSQL Outbox path reviewed above.
- It posts the returned reply directly to the originating Discord channel. Therefore, in a shared allowlisted channel, an allowed user's task and Sofia's response are visible to other channel members unless Discord permissions or product policy restrict visibility.
- Its `seen`, `inflight`, and pending message state is process-local. A daemon restart loses this deduplication state; the request idempotency key is useful only if the API endpoint persists and enforces it durably for the authenticated principal.
- The current daemon's direct-send path does not propagate an outbox delivery ID or Discord nonce. The outbox adapter's retry-deduplication guarantees do not apply to this daemon path.

No code change was made to this worker in this review because changing channel visibility or switching its request path would alter the integration's behavior and requires an explicit product decision. Recommended release policy: use private DM delivery for personal tasks, or require explicit shared-channel mode with a clear warning that messages and results are visible to channel members. Also add a durable message-ID idempotency contract to the run endpoint before treating gateway retries as restart-safe.

## Additional source-level tests

Added source-level SQL contract tests that explicitly assert:
- An expired processing lease is eligible for reclaim under the `SKIP LOCKED` claim statement and the new worker token replaces the previous lease token.
- A stale worker's ACK and retry both fail when the store reports no affected row, with each mutation requiring processing status, matching worker token, and a still-live lease.

These tests have not been executed. They prove the intended SQL predicates are present, not actual PostgreSQL locking behavior or transaction isolation.

## Discord Gateway async-run idempotency correction

A source review of `workers/discord-gateway/daemon/worker.mjs` and `src/api/server.ts` found that the gateway sent an `Idempotency-Key` header but omitted `async: true`. The API only evaluates the idempotency key in its async-run branch; the synchronous branch ignored it. Consequently, the gateway's apparent retry protection did not protect synchronous requests.

Updated the gateway to:
- Submit Discord tasks with `async: true`, retaining the deterministic `discord_<message.id>` idempotency key.
- Validate the returned run ID and status.
- Poll the owner-authenticated `GET /api/v1/agent/runs/:id` endpoint while the run is queued/running.
- Send the final completed result, or a bounded failure/cancellation explanation, rather than prematurely treating the queued acknowledgement as the final answer.
- Reuse the same idempotency key when Discord redelivers a message, so a replay can attach to the existing async run where the API's idempotency store is shared.

Changed file: `workers/discord-gateway/daemon/worker.mjs`.

Important remaining limitation: the API's idempotency index is process-local and is rehydrated from `RunRecordStore`; the Vercel adapter currently uses `FileRunRecordStore` under `os.tmpdir()`. This is not a cross-instance transactional idempotency guarantee. Concurrent requests reaching different Vercel instances, ephemeral filesystem loss, or a crash before the initial run record is durably saved can still permit duplicate work. A shared database-backed run/idempotency reservation is required before claiming restart-safe, multi-instance deduplication.

Validation: inspected the changed source and API route contract. No Node syntax check, unit test, build, typecheck, live Vercel test, or multi-instance test was executed in this environment. No migration, deployment, merge, or production change was performed.
