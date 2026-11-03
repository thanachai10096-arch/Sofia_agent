# Durable Model Call Settlement Journal

`SqliteModelCallJournal` is an additive persistence primitive for recording provider-call dispatch and settlement evidence. Opening this optional journal requires Node.js 22.5 or newer because it uses the built-in `node:sqlite` module; Sofia core still advertises Node.js `>=20`, but the journal feature is unavailable on Node 20 and older Node 22 releases. The API reports this requirement explicitly if the built-in module is unavailable. It is not yet wired into `TokenAwareGateway`, `TokenBudget`, or `DurableJobRuntime`; the existing in-memory budget remains unchanged until integration can preserve its current limits and error behavior.

## State model

- **dispatched** — the idempotency key was atomically claimed and committed before provider network I/O. A crash at or after this point is ambiguous: the provider may or may not have received and billed the request.
- **settled** — actual token usage and calculated cost were durably recorded.
- **indeterminate** — recovery explicitly marked an unresolved dispatch. This does not mean the provider did not bill the call.

`beginDispatch()` uses `BEGIN IMMEDIATE` and a primary-key uniqueness constraint. Only the first caller receives `shouldDispatch: true`; concurrent or later callers receive the existing entry with `shouldDispatch: false`. Reusing a key with different run/provider/model/attempt/reservation metadata fails closed.

`settle()` is idempotent when the exact same usage and cost evidence is submitted again. Conflicting evidence is rejected rather than silently overwriting the first settlement. An indeterminate call may still be settled later if authoritative provider usage becomes available.

## Required integration contract

1. Derive a stable idempotency key from the logical run, phase/call slot, and attempt. Do not use a new random ID for a retry of the same logical call.
2. Call `beginDispatch()` and commit its `shouldDispatch` decision **before** invoking the provider. Never invoke the provider when it returns `false`.
3. Persist provider-reported usage and calculated cost with `settle()` as soon as the response is received, before exposing a successful result to the rest of the Brain.
4. If a process restarts with an unresolved dispatched row, mark it indeterminate and do not automatically replay the provider request. Reconcile against provider request IDs/usage APIs where supported; otherwise require an explicit policy decision.
5. Keep prompt text, credentials, authorization headers, and raw provider response bodies out of the journal. Store only bounded identifiers and metering evidence.
6. Use a shared transactional database for multi-host deployments. SQLite coordinates processes sharing the same database file; it is not a distributed multi-host database over arbitrary network filesystems.

## Deliberate limitations

- This first slice records durable evidence and suppresses duplicate dispatch for a reused idempotency key. It does **not** provide exactly-once provider execution: a crash can occur after the dispatch row commits but before the network request begins, or after provider billing but before settlement.
- The caller must define stable logical-call identity and the policy for a genuinely new attempt. Generating a new attempt key automatically after an ambiguous dispatch can still duplicate provider charges.
- Cost is supplied by the caller as integer nano-USD. Pricing/catalog changes and currency conversion remain caller responsibilities.
- The journal does not replace `TokenBudget` reservation enforcement. Integration must atomically coordinate reservation, dispatch, and settlement semantics or clearly document residual failure windows.
- No automatic pruning is enabled; retain/backup/delete policy must be designed before production use so audit evidence is not removed unexpectedly.

## Verification

`src/brain/model-call-journal.test.ts` covers duplicate dispatch suppression across two SQLite connections, idempotency-key mismatch, duplicate/conflicting settlement, restart recovery, indeterminate state, and input/query validation. The CI run for the commit that introduces this module is the required typecheck/build/test evidence; do not treat this document or mocked unit tests as proof of multi-host exactly-once execution.
