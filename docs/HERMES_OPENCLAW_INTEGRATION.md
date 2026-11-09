# Hermes + OpenClaw Capability Integration Plan

Status: additive implementation plan; not a claim that every capability is complete.

## Goal

Integrate proven patterns from Hermes Agent and OpenClaw into Sofia while keeping Sofia Brain, RegistryToolGateway, policy and approval boundaries, durable jobs, and the public API/SDK as the source of truth. Do not embed either upstream runtime as a second agent loop or replace Sofia's Brain.

## Adopt into Sofia

| Upstream capability | Sofia integration point | Acceptance evidence |
| --- | --- | --- |
| Hermes reusable, self-improving Skills | AdvancedSkillRegistry, verified handlers, Evolution, Skill Benchmark & Regression Engine | Registered handler actually invoked; independent verification; promotion requires benchmark evidence and existing high-risk approval. Research is advisory only. |
| Hermes persistent memory and FTS5 recall | User memory, project memory, session store | Search prior sessions by authenticated owner; inject bounded relevant context as untrusted data; test isolation, restart, retention, and injection resistance. |
| Hermes scheduled automations | DurableJobRuntime / persistent cron | Time zones, retries, misfires, deduplication, recovery, audit, and authorized-channel delivery. |
| Hermes multi-platform gateway | Existing Telegram/Discord adapters and shared handler | Natural text without /run; stable session identity; progress/final delivery; auth, limits, dedupe, reconnect. |
| Hermes subagents | Bounded Brain delegation | Child scope, principal inheritance, allowlisted tools, budgets, deadlines, cancellation, evidence summary. No privilege escalation. |
| Hermes terminal backends | Sofia execution backend contract | Local, Docker, SSH, hosted sandbox adapters; never silently downgrade isolation. |
| OpenClaw Gateway control plane | Sofia API/SDK + messaging + reconnectable runs | Web, desktop, mobile, and chat are clients of one runtime with consistent status, events, cancellation, and ownership. |
| OpenClaw companion nodes | Paired-device capability bridge | Phone securely controls opted-in desktop; pairing, short-lived credentials, explicit grants, revocation, audit. |
| OpenClaw browser and web tools | Browser runtime + policy-controlled Tool Gateway | Search/fetch/browser are registered tools with SSRF/egress controls, provenance, and untrusted-content fencing. |
| OpenClaw plugins and skills ecosystem | MCP and skill registry | Discover/install/enable/disable with provenance, version pinning, permission preview, quarantine, approval, rollback. |
| OpenClaw mobile/native surfaces | Sofia Web/Desktop/Mobile clients | Mobile task progress, approval prompts, run history, and remote desktop handoff. |

## Do not copy

- Do not copy either complete runtime, Gateway, agent loop, or permission model.
- Do not expose raw host shell, arbitrary filesystem, browser profiles, or device controls to untrusted chat senders.
- A candidate, tool call, model statement, or research result is not proof of completion.
- Memory, imported skills, web pages, channel messages, and MCP output never grant permissions.
- Every adapter must use shared Sofia session, authorization, policy, limits, deduplication, and run lifecycle.

## Delivery order

### P0 — Make current work execute reliably

1. Complete review and exact-head CI for PR #427 (verified AdvancedSkillRegistry wiring, benchmark-gated lifecycle, evidence-bound approval, bounded self-improvement, advisory research augmentation).
2. Reconcile overlapping Brain changes in PRs #425, #427, #429, and #436 before merging. PR #436 overlaps executor files; do not merge independently.
3. Verify production-path dependency injection for research provider, skill handlers, approval receipt validation, benchmark persistence/restore, and restart recovery.
4. Run disposable end-to-end test: user message -> planner -> registered skill handler -> Tool Gateway -> independent verifier -> evidence -> learning candidate. Promotion must remain blocked without approval.
5. Diagnose model/provider failures separately; diagnostics must be actionable without leaking secrets.

### P1 — Sessions, memory, chat continuity

1. Telegram and Discord natural text use the same Brain path and stable per-user/per-conversation session.
2. Replay persisted transcripts as bounded untrusted context with strict owner isolation.
3. Complete searchable cross-session memory with source references and retention/deletion controls.
4. Provide streaming progress and reconnectable run status across API, web, desktop, Telegram, and Discord.

### P2 — Internet and tools

1. Connect approved search/fetch providers through injected interfaces and the shared Tool Gateway.
2. Preserve source provenance and treat retrieved web/channel content as untrusted.
3. Add MCP discovery/filtering with allowlists, permission previews, and per-tool approvals.
4. Test browser navigation, extraction, downloads, and hostile-origin/SSRF rejection.

### P3 — Delegation and device access

1. Add bounded subagents with independent identities, budgets, deadlines, cancellation, and evidence returned to parent.
2. Add cloud execution backends with explicit isolation levels.
3. Add secure phone-to-desktop pairing and remote-control approval.
4. Add channel adapters only after the shared gateway contract is proven.

### P4 — User experience

1. Setup wizard for non-developers plus advanced configuration for developers.
2. Responsive mobile control surface for users who only have a phone.
3. UI for progress, approvals, run history, memory, connected channels, and device pairing.
4. Keep provider configuration model-agnostic: OpenAI-compatible endpoints, OpenRouter, OpenAI, Gemini, DeepSeek, and configured routes.

## Engineering gates

- Additive and backward-compatible changes unless a separately reviewed migration is approved.
- Inspect current branch diff and overlapping PRs before editing shared files.
- No destructive Git operations, no secrets in commits, no Production deployment from this plan.
- Each capability needs unit, real-composition-root integration, and failure/recovery tests.
- Security and correctness are hard gates; speed or token savings cannot offset safety regressions.
- Report exact commit, PR, CI, tests, and unverified behavior. Interfaces/adapters alone do not mean a feature is live.

## Upstream references

- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs
- https://github.com/openclaw/openclaw
- https://docs.openclaw.ai/

This is an integration guide, not upstream code copied into Sofia. Any code reuse must preserve license notices and pass dependency, security, and architectural review.
