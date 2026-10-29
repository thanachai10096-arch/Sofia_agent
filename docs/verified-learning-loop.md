# Verified Learning Loop

The loop is an additive extension point for Sofia's existing Brain, Skill Lifecycle, and Project Memory. It does not create a second runtime or replace the current managed-skill workflow.

## Data flow

1. `SofiaBrain` reaches its existing successful-verification and code-review path.
2. Optional `onVerifiedCompletion` callback fires. It must not be wired to raw model text or an unverified event.
3. `createVerifiedCompletionHandler` resolves an authenticated tenant/principal/project scope and calls `persistFinalizedReceipt`. That adapter must persist an authoritative receipt using Sofia's trusted verifier and evidence store; the callback payload alone is not a receipt.
4. `VerifiedLearningLoop` re-reads the receipt and evidence, checks scope, age, success, and policy revision, then records the experience idempotently.
5. Only repeated patterns are considered for skill candidates. The candidate must pass policy assessment, a real regression run with evidence, and a final policy-revision check before activation.
6. Retrieval is scoped to the authenticated tenant, principal, and project and filters out skills created under a stale policy revision.

## Required host adapters

`VerifiedLearningHost` must be implemented against the existing Sofia stores and policy/verifier interfaces. `SqliteLearningTransactionStore` now supplies a durable transaction-port implementation for experiences, candidates, evaluations, and active skills. It enforces atomic uniqueness for (tenantId, principalId, projectId, receiptId), scope checks, rollback, and private POSIX database-file permissions. Compose it with `withSqliteLearningTransactions(existingServices, store)`; the other host services remain required and must be the authoritative receipt/evidence lookup, policy assessor, and real regression runner. The adapter does not fabricate these services or enable learning by itself.

`SelfImprovementCheckpointStore` must persist notification cursor and pending out-of-order notifications durably and atomically. `SqliteSelfImprovementCheckpointStore` is the durable cursor/pending-event implementation; the in-memory implementation in tests remains only a test double. The `persistFinalizedReceipt` adapter must return a sequence from a durable source; do not invent a sequence from process-local counters.

## Transaction and lifecycle integration boundaries

The loop now commits the experience/history snapshot first, then runs policy assessment and regression checks outside the SQLite write transaction. Candidate/evaluation persistence and final activation use separate short transactions. This avoids holding SQLite's `BEGIN IMMEDIATE` lock while external policy or regression adapters run. Because these phases are intentionally separate, adapters and callers must tolerate a persisted experience/candidate without activation after interruption; activation remains gated by verified regression evidence and a fresh policy revision. Receipt retries now recover an already-persisted experience by its scoped receipt ID and can resume candidate assessment/regression after an interruption, rather than silently treating every duplicate receipt as permanently finished. Recovery is idempotent at the receipt/experience boundary; external evaluation may be repeated after a crash and therefore must be safe to rerun.

The `learning_active_skills` table is the loop's durable record, **not** proof that a skill has been registered with Sofia's runtime. The loop now fails closed unless `VerifiedLearningHost.promoteCandidate` is configured and returns true after a successful regression and fresh-policy check. `createLearningLifecyclePromoter` adapts candidates to the existing `VersionedSkillLifecycle` workflow, resolves persisted evidence IDs, runs the lifecycle evaluator, and requires the existing high-risk explicit approval handler before registering the skill with `SkillsPlatform`. Without an approval handler or evidence IDs, promotion is denied. Production wiring must still supply the authoritative evidence resolver, run-ID resolver, lifecycle evaluator, and approval mechanism, and must be verified with end-to-end tests before enabling learning in production.

## Safety notes

- The loop rejects missing, stale, cross-scope, failed, or untrusted evidence.
- Candidate text is redacted and bounded; it is still untrusted instruction data and must be treated as such when later presented to a model.
- Regression evaluation must execute real checks. Metadata labels such as `typecheck`, `test`, and `build` are not evidence that those checks passed.
- The Brain callback is best-effort and cannot change a verified task into a failed task.
- This change does not automatically deploy or enable production learning. A production adapter must be reviewed and tested against the actual durable stores and policy gateway before activation.


## Read-only activation reconciliation

`reconcileLearningActivationState(scope, learningSkills, runtimeSkills)` compares scope-filtered records from the learning SQLite store and an authoritative runtime/lifecycle adapter. It reports missing runtime registration (possible crash after learning-store/runtime divergence), runtime-active skills without a learning record, policy-revision drift, duplicate IDs, and cross-scope input. The function is deliberately read-only: it never activates, unregisters, deletes, or overwrites a skill. The caller must obtain runtime records from an authoritative adapter that can prove tenant/principal/project ownership; a global lifecycle listing without scope provenance must not be passed as if it were scoped. Repair should be implemented separately as an audited, idempotent operation after the report is reviewed. This detects inconsistencies but does not claim to make two separate stores atomic.


## Conservative repair planning

`planLearningReconciliationRepair` converts a reconciliation report into a non-mutating proposal. It only proposes a missing runtime registration when the authenticated scope matches, an operator explicitly approves that skill ID, the freshly read learning-record policy revision exactly matches the current authoritative policy revision, and trusted evidence has been re-resolved. Duplicate IDs, policy drift, runtime-only activations, and mixed/conflicting issues are blocked rather than guessed at. The generated idempotency key is per plan and skill, and the returned `eligibleForExecutor` flag means only that the planner's gates passed—not that execution is safe without fresh executor-side revalidation.

This is intentionally **planning only**, not a repair executor. Before applying any action, a separate host adapter must re-read the learning and runtime stores, compare the exact expected policy revision and scope, persist an idempotency journal, emit an audit intent/result, and perform registration through the existing approved skill lifecycle. The plan must never be treated as proof that a mutation occurred; a crash between stores remains possible and requires a fresh reconciliation.


## Audited repair executor

`SqliteLearningRepairJournal` persists repair idempotency state and append-only audit events in a separate SQLite journal. `executeLearningRepairPlan` accepts only eligible plans, checks scope binding, re-reads authoritative policy/approval/evidence/runtime state before mutation, records a repair attempt, calls an injected adapter that must use Sofia's existing approved lifecycle, and verifies the authoritative postcondition before marking success. Failed attempts remain journaled and may be replayed; if the process crashed after runtime registration, a replay can detect the already-satisfied postcondition and avoid a duplicate registration.

The executor is deliberately not auto-wired to production. The host must provide authenticated, authoritative revalidation and an idempotent lifecycle adapter. A journal and a runtime store are separate persistence systems, so no cross-database atomicity is claimed. Audit rows are append-only through this API; operational access to the journal file still needs deployment-level filesystem/backup controls. A production rollout requires end-to-end tests against the real approval, evidence, policy, lifecycle, and runtime adapters.

### Repair journal audit integrity

The SQLite repair journal now installs database triggers that reject updates and deletes from `learning_repair_audit`, so append-only behavior is enforced by SQLite rather than relying only on application convention. Audit writes also validate the event name, non-empty key/actor/skill identifiers, and parseable timestamp before insertion. This is tamper-resistance within the SQLite API boundary, not a cryptographic or externally immutable audit log; production deployments needing stronger tamper evidence should export events to an independently controlled append-only sink.
