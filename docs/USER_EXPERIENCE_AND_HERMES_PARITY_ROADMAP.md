# Sofia Agent: User Experience and Hermes-Parity Roadmap

This document defines a product roadmap, not a claim that every capability is already implemented. Use the code and current CI on the exact commit as the source of truth.

## Product direction

Sofia should feel like a persistent assistant that users can reach from the tools they already use. The differentiator is a Thai-first experience with explicit permissions, evidence-backed verification, and auditable work—not a feature-count race.

Keep one shared Sofia Core and versioned API. Web, desktop, mobile, Telegram, Discord, LINE, and future adapters must call the same core. Adapters may map identities, format messages, and handle transport/retries, but must not bypass authentication, Tool Gateway authorization, approvals, quotas, or audit boundaries.

## Priority 0 — prove continuity

1. **Session continuity:** replay a bounded, ordered window of recent turns for the authenticated session. Keep the current user request distinct from reference context.
2. **User memory:** retrieve only memories belonging to the authenticated principal, rank them for relevance, and include a small bounded set in model context. Memory is untrusted reference data—not policy, permission, or a source of new authority.
3. **Persistence:** document which stores are temporary, local durable, or shared/transactional. Do not describe file-backed single-process stores as multi-host durable.
4. **User controls:** provide clear ways to inspect, correct, and delete stored memories and clear a conversation. Avoid storing inferred personal facts without user intent.
5. **Failure behavior:** memory and transcript retrieval should be best-effort where safe; storage/authorization failures must never silently cross user boundaries.

**Acceptance evidence:** tests for principal isolation, context ordering and bounds, secret redaction, prompt-injection fencing, deletion, restart behavior, disabled-by-default behavior where configured, and the exact CI run for the reviewed commit.

## Priority 1 — conversational messaging

1. Make Telegram ordinary-text conversation work without requiring `/run`; retain `/run` for explicit task execution and backward compatibility.
2. Support Thai-first onboarding, help, greetings, follow-ups, and clear distinction between casual chat and actions that can change files or external systems.
3. Persist bounded conversation context across restarts only when configured with a suitable private persistent store.
4. Preserve per-user/per-chat identity mapping, allowlists, deduplication, rate limits, cancellation, safe error reporting, and delivery acknowledgements.
5. Add LINE as a new adapter only after documenting webhook signature verification, replay/deduplication, user identity mapping, rate limiting, message-size handling, and secret storage. Reuse the existing messaging contracts and Sofia Core; do not build another agent runtime.
6. Add Discord and other channels through the same adapter contract and prove that each channel reaches the same authorization and policy gates.

**Acceptance evidence:** adapter contract tests plus integration tests for authorized and unauthorized senders, duplicate events, timeouts/retries, provider/model errors, long responses, and follow-up context. A green unit suite alone does not prove the deployed bot works.

## Priority 2 — user-controlled model configuration

The product should offer a provider-neutral model preference while preserving secure defaults:

- `auto`: Sofia chooses among explicitly configured, permitted routes.
- `provider/model`: user or administrator selects a specific configured route.
- Optional organization policy can restrict available providers/models and override user preference.
- Do not silently fall back to another provider when the selected route fails; explain the failure and require an explicit fallback policy.
- Keep credentials server-side. Never accept raw API keys in chat messages, expose shared master keys to clients, or log prompts/secrets.
- Apply budgets, quotas, timeouts, context limits, and provider capability checks consistently regardless of selected model.
- Make the effective provider/model visible through safe diagnostics without exposing credentials or private prompts.

**Acceptance evidence:** configuration validation, unauthorized-provider rejection, model-route selection tests, no-silent-fallback tests, secret-redaction tests, and real-provider smoke tests with explicitly configured credentials. Provider smoke tests may incur third-party costs.

## Priority 3 — one-command setup

1. Verify the published package and `sofia` CLI from a clean machine and supported Node.js versions.
2. Provide a guided setup for local runtime, model credentials, storage, and optional messaging adapters.
3. Keep secrets in environment variables or a private local secret store; never write them to example files, logs, or generated public configuration.
4. Separate a local self-hosted install from hosted deployment instructions. Make optional browser/Docker dependencies and platform limitations explicit.
5. Publish a short Thai quick-start video only after the documented steps are reproducible from a clean checkout/package.

**Acceptance evidence:** clean-install CI on supported operating systems, smoke tests for CLI startup and health, and a reproducible quick-start with no undocumented manual steps.

## Priority 4 — trust and commercial readiness

- Show task status, key actions, verification evidence, and actionable failure reasons without leaking sensitive tool output.
- Do not report success unless verification supports the claim.
- Require explicit approval for consequential actions and preserve cancellation and audit history.
- Before hosted or enterprise launch, implement and test quotas, spend caps, data-retention controls, backups, monitoring, support boundaries, and multi-tenant isolation.
- Keep the core useful and open source; sell managed operations, team controls, deployment support, and reliability only when they actually exist.

## Existing work to reconcile before starting duplicate implementation

Review the latest head and CI for these existing pull requests before stacking or duplicating work:

- Session replay and user-memory retrieval: [PR #260](https://github.com/thanachai10096-arch/Sofia_agent/pull/260)
- Scoped user-memory context in Brain: [PR #268](https://github.com/thanachai10096-arch/Sofia_agent/pull/268)
- Easier plain-language Telegram tasks: [PR #255](https://github.com/thanachai10096-arch/Sofia_agent/pull/255)
- More conversational Telegram behavior: [PR #256](https://github.com/thanachai10096-arch/Sofia_agent/pull/256)
- Persistent messaging sessions and chat/task modes: [PR #258](https://github.com/thanachai10096-arch/Sofia_agent/pull/258)

These references identify work to review; they do not mean the PRs are merged, CI-green, or production-ready.

## Delivery and safety gates

- Inspect the current base branch and each PR's changed files before editing.
- Keep changes additive and narrowly scoped; do not overwrite user work or rebuild an existing runtime.
- Never merge or deploy automatically as part of this roadmap.
- Do not change production secrets, production services, or destructive state.
- Require green CI on the exact reviewed head and inspect the final diff before merge.
- Report evidence precisely: distinguish source changes, passing automated tests, real-provider tests, and deployed end-to-end behavior.
