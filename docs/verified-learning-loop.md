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
