# Sofia Agent: Thai Messaging and Channel Integration Plan

This document narrows the channel work into implementation-ready acceptance criteria. The broader product roadmap, including memory, skills, durable jobs, model configuration, setup, and commercial boundaries, belongs in [HERMES_PARITY_ROADMAP.md](HERMES_PARITY_ROADMAP.md). This plan does not claim that any channel is production-ready.

## Target experience

Sofia should feel natural in Thai and let users continue a conversation without memorizing commands, while clearly separating ordinary chat from actions that can change files, run tools, or affect external systems.

All channels must use the existing Sofia Core and policy path. A channel adapter is transport glue, not a second agent runtime.

## Phase 0 — reconcile existing messaging work

Before adding another adapter, review current code and exact-head CI for:
- [PR #255 — plain-language Telegram tasks](https://github.com/thanachai10096-arch/Sofia_agent/pull/255)
- [PR #256 — conversational Telegram behavior](https://github.com/thanachai10096-arch/Sofia_agent/pull/256)
- [PR #258 — persistent messaging sessions and chat/task modes](https://github.com/thanachai10096-arch/Sofia_agent/pull/258)
- [PR #260 — session replay and scoped user memory](https://github.com/thanachai10096-arch/Sofia_agent/pull/260)

Do not stack duplicate implementations. Reconcile overlapping contracts and tests first; these links are pointers to review, not proof of merge or deployment.

### Telegram acceptance criteria

- Plain text can continue a conversation without requiring `/run`; retain `/run` for explicit task execution and compatibility.
- `/start` and `/help` explain the available capabilities in concise Thai.
- Follow-up questions use a bounded, ordered recent transcript only for the correct user/chat scope.
- Casual replies do not silently trigger tools. Consequential actions must pass the same policy and approval gates as API/CLI requests.
- Long responses, timeouts, provider errors, duplicate updates, cancellation, and delivery failures have tested behavior.
- User-facing errors are actionable but redact credentials, internal prompts, and sensitive tool output.

## Phase 1 — shared channel contract

Before adding LINE, define or reuse one adapter contract with:
- verified platform identity and sender/conversation identifiers;
- normalized text, attachment metadata, and event id;
- deduplication/idempotency key;
- explicit response status and provider delivery error;
- bounded context/session identifier;
- cancellation and timeout semantics.

The adapter may normalize and format messages but must not choose a less restrictive policy, manufacture authenticated principal IDs, or bypass the shared Tool Gateway.

## Phase 2 — LINE adapter (Thailand priority)

Implement LINE only after confirming the available messaging abstractions and test conventions in the current repository.

Security and reliability requirements:
1. Verify the LINE webhook signature against the exact raw request body before parsing or acting.
2. Keep the channel secret and access token server-side; never commit them or echo them in logs/errors.
3. Deduplicate webhook events and safely handle provider retries.
4. Map LINE user/group/room identifiers to an authenticated Sofia principal using an explicit allowlist or trusted account-linking flow; identifiers alone are not proof of authorization.
5. Apply per-principal rate limits, task budgets, timeouts, and bounded message/context sizes.
6. Use the same approval, run-ownership, audit, and tool-policy path as other entrypoints.
7. Handle unsupported attachments, empty events, malformed signatures, revoked users, provider outages, and send-message failures without claiming a task completed.
8. Make webhook health and delivery failures diagnosable without exposing secrets or private conversation contents.

### Required tests

- Valid and invalid signatures, including altered raw body.
- Duplicate/replayed event delivery and concurrent duplicate requests.
- Unauthorized sender, missing identity, revoked allowlist entry, and cross-user/session isolation.
- Oversized messages, unsupported event types, malformed payloads, and rate-limit rejection.
- Provider timeout/retry behavior and safe failure reporting.
- Proof that a consequential request reaches the same policy/approval gates as the API.
- Follow-up context is bounded and treated as untrusted reference data, never as permission or system instructions.

## Phase 3 — prove operation before calling it ready

A channel is not operational merely because unit tests pass or a webhook endpoint exists. For each release candidate, record:
- exact commit SHA and CI run URLs;
- automated adapter/security test results;
- a real provider smoke test with test credentials;
- successful inbound message, authorized task, follow-up, and outbound response;
- negative test for unauthorized sender and duplicate delivery;
- deployment environment and limitations (test vs production).

Do not deploy to Production as part of this work. Keep provider credentials in the test environment and do not claim live success without an observed end-to-end result.

## Engineering gates

- Inspect git status/diff, public interfaces, dependencies, and tests before code edits.
- Prefer small, additive changes; preserve existing runtime, Tool Registry, job engine, and policy system.
- No destructive Git operations, production configuration changes, or automatic merges.
- Require green CI on the exact reviewed head and inspect the final diff before merge.
