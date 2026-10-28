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

`VerifiedLearningHost` must be implemented against the existing Sofia stores and policy/verifier interfaces. Its transaction implementation must provide atomic uniqueness for the tuple (tenantId, principalId, projectId, receiptId), and it must persist experiences, candidates, evaluations, and active skills. Do not implement this contract with an in-memory map in production.

`SelfImprovementCheckpointStore` must persist notification cursor and pending out-of-order notifications durably and atomically. The in-memory implementation in tests is only a test double. The `persistFinalizedReceipt` adapter must return a sequence from a durable source; do not invent a sequence from process-local counters.

## Safety notes

- The loop rejects missing, stale, cross-scope, failed, or untrusted evidence.
- Candidate text is redacted and bounded; it is still untrusted instruction data and must be treated as such when later presented to a model.
- Regression evaluation must execute real checks. Metadata labels such as `typecheck`, `test`, and `build` are not evidence that those checks passed.
- The Brain callback is best-effort and cannot change a verified task into a failed task.
- This change does not automatically deploy or enable production learning. A production adapter must be reviewed and tested against the actual durable stores and policy gateway before activation.
