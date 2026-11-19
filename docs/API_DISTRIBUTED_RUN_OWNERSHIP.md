# API Distributed Run Ownership

Status: partially implemented foundation. `src/api/run-ownership-store.ts` now provides an Upstash Redis lease adapter with atomic claim, renewal, assertion, release, principal binding, and fencing generations. It is not yet wired into API Run execution or recovery. The current `SofiaApiConfig.runStore` remains single-instance only.

## Problem

The API currently treats every persisted `queued` or `running` run as interrupted during process startup. This is safe only when one API process owns the run store. If two live API instances share the same store, a newly started instance can incorrectly fail a run that is still executing on another instance and cancel that run's pending approvals.

A shared filesystem does not solve this: atomic file writes protect record integrity, not distributed ownership or worker liveness.

## Required safety invariants

1. **One live owner:** at most one instance may execute a given run at a time.
2. **Lease before execution:** a worker must atomically claim a run before changing it to running or invoking tools.
3. **Fenced writes:** every heartbeat, checkpoint, terminal update, and approval cancellation must carry the current monotonically increasing fencing token (or an equivalent unforgeable lease generation). A stale owner must be unable to overwrite a newer owner's state.
4. **Heartbeat:** owners renew leases periodically; lease duration must exceed the heartbeat interval by a documented safety margin.
5. **Expiry is not proof of death:** takeover is allowed only after the authoritative lease store confirms expiry using its own atomic clock/operation. Local wall-clock observations must not authorize takeover.
6. **Owner-scoped approvals:** approval cancellation during recovery is allowed only after a successful fenced takeover and must match both run ID and principal ID.
7. **Fail closed:** lease-store timeouts, malformed responses, or ambiguous claims must stop execution/recovery; they must never be interpreted as a free lease.
8. **No secret exposure:** lease tokens and fencing values are internal metadata and must never appear in public Run API responses, logs, traces, or client events.

## Proposed contract

Introduce a `RunOwnershipStore` abstraction separate from `RunRecordStore`:

- `claim(runId, principalId, instanceId, leaseMs)`: atomically claim an unowned/expired run and return a lease containing a fresh fencing generation; otherwise return no lease.
- `renew(lease, leaseMs)`: atomically extend only if run, principal, instance, token, and generation still match and the lease has not expired.
- `assertCurrent(lease)`: authoritative check before any externally visible side effect or checkpoint.
- `release(lease)`: release only the exact current lease; stale release must be a no-op.
- `listRecoverable()`: optional index-assisted discovery; each candidate still requires atomic claim before recovery.

Lease identity must include the tenant principal. Run IDs alone are not globally trusted ownership identifiers.

## Adapter strategy

### First adapter: Upstash Redis

Implemented foundation: `UpstashRunOwnershipStore` in `src/api/run-ownership-store.ts` uses Redis Lua scripts for claim, renew, assert-current, and release. The claim script binds a run ID to a principal for a configurable retention window, increments a persistent fencing counter, and stores the active lease with Redis TTL. All keys for a run use the same Redis Cluster hash tag.

The adapter is not yet connected to `createSofiaApi`, RunRecord persistence, tool execution, checkpoint writes, or approval recovery. The tests currently mock the Upstash REST transport; they are not a live Redis integration test.

Use a Redis Lua script for each state transition. Keep all keys used by one script in the same Redis Cluster hash slot. The script, not the application process, performs compare-and-set checks and increments the fencing generation. Use server-side Redis time where supported; never compare expiry using a worker's local clock.

The adapter must validate all returned fields and fail closed on malformed or partial responses. Secrets remain server-side environment configuration.

### Local adapter

The existing file-backed Run Store remains explicitly single-instance. A local lock file may coordinate processes on one host, but it is not a distributed lease and must not be advertised as multi-host safe.

## API integration sequence

1. Persist a new run as queued.
2. Claim its lease before starting execution.
3. Persist running state with the lease generation.
4. Renew heartbeat while execution is active; abort the run if renewal fails.
5. Before checkpoint/terminal persistence and before approval cancellation, verify the lease generation is still current.
6. On startup, enumerate candidates but do not mark them failed based on status alone. Attempt an atomic claim; only the successful claimant may mark the prior attempt interrupted and cancel its pending approvals.
7. Release on terminal completion. If the process crashes, lease expiry enables a later owner to recover.

## Rollout and compatibility

- Existing `runStore` users remain single-instance and must not share the directory across API processes.
- Multi-instance mode must require an explicitly configured distributed `RunOwnershipStore`; missing configuration is a startup error, not a fallback to unsafe recovery.
- Keep the current single-instance behavior available for local/self-hosted users.
- Do not change Railway Production or deploy automatically as part of this work.

## Required verification before enabling multi-instance mode

- Two-worker contention: exactly one claim succeeds.
- Expired lease takeover: one new owner wins and receives a higher fencing generation.
- Stale heartbeat/write/release: all rejected after takeover.
- Principal isolation: another tenant cannot claim, renew, inspect, or cancel a run.
- Approval race: an approval created while a run is live is not cancelled by a non-owner.
- Crash/restart: only a successful lease claimant performs recovery.
- Redis timeout, malformed response, and network partition: no execution without a confirmed lease.
- Clock skew: lease decisions remain correct because expiry is evaluated by the authoritative store.
- Chaos tests: kill owner during tool call, heartbeat, checkpoint, and terminal persistence.
- End-to-end tests across at least two independent API processes against a real Redis instance.

Until the adapter is wired into every Run state transition and the multi-process checks pass, Sofia must describe API Run persistence as single-instance and must not claim multi-instance Run recovery is supported.
