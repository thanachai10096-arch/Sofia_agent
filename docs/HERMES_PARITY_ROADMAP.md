# Hermes-like General-Purpose Agent Roadmap

**Purpose:** make Sofia Agent a cohesive, general-purpose assistant platform—not a coding-only product—while preserving its existing Core, security boundaries, and MIT-licensed open-source direction.

This is a product/engineering roadmap, not evidence that every item below is implemented. The current source of truth for integrated capabilities and release blockers remains [READINESS-MATRIX.md](READINESS-MATRIX.md).

## Product contract

A user should be able to state a goal in natural language and have Sofia:

1. understand the request and ask for clarification when necessary;
2. plan and execute bounded work through registered, policy-controlled tools;
3. use relevant skills and explicitly saved user/project memory as context—not as permission;
4. report progress, evidence, costs where available, and remaining uncertainty;
5. verify outcomes, repair or replan within limits, and stop safely when approval or user input is required;
6. continue eligible long-running work after disconnection or restart;
7. expose the same Core through CLI, API/SDK, desktop and supported messaging clients.

Model routing remains an internal policy. Clients must not bypass authentication, tool policy, approval gates, or run ownership.

## Delivery order

### P0 — Prove one trustworthy end-to-end path

- [ ] Maintain one tested path from request → plan → authorized tools → independent verification → repair/retry → final report.
- [ ] Exercise cancellation, duplicate submission, restart recovery, checkpoint/resume and worker contention against the integrated main branch.
- [ ] Run negative security tests for cross-user access, approval denial, path/symlink escape, secret leakage, prompt injection and sandbox egress.
- [ ] Keep production and multi-host claims blocked until the relevant live tests and shared transactional infrastructure exist.

**Exit evidence:** exact-head CI, repeatable end-to-end tests, and a documented failure report for each negative case.

### P1 — Make memory and skills useful during real work

- [ ] Integrate explicit user-memory retrieval into run context only when the authenticated principal has memory-read permission.
- [ ] Keep retrieved memory fenced as untrusted context; it must never grant tools, permissions or override the current request.
- [ ] Test owner isolation, deletion/forget behavior, prompt-injection resistance, bounded context size and failure-safe retrieval.
- [ ] Prove that skill matching reaches real handlers, and only promote learned skills after independently verified success and required approval.
- [ ] Track success/failure history without treating model claims as evidence or calling heuristic confidence “training”.

**Exit evidence:** tests show memory affects relevant tasks, does not cross principals, and cannot change authorization; skill activation and ranking have deterministic regression tests.

### P1 — Make automation persistent and controllable

- [ ] Validate cron create/list/pause/resume/run/delete, ownership, restart recovery and duplicate dispatch against persistent storage.
- [ ] Ensure each long-running job has status, cancellation, bounded retries, trace/evidence and a clear recovery outcome.
- [ ] Keep subagent delegation bounded by inherited permissions, budgets, deadlines and cancellation.
- [ ] Use a transactional shared store/queue before claiming multi-host job coordination or globally enforced quotas.

**Exit evidence:** cross-process tests, restart tests, ownership tests and outage tests on the exact integrated revision.

### P1 — Make channels share the same Sofia Core

- [ ] Keep CLI, API/SDK, desktop and messaging adapters as thin clients of the same authenticated Core.
- [ ] Validate signed webhooks, sender/channel allowlists, replay protection and per-user run ownership for each provider.
- [ ] Keep privileged API/provider secrets server-side; mobile and browser clients must not contain master keys.
- [ ] Add a web chat/BFF and supported desktop/mobile clients only with reconnect, approval and cancellation flows.

**Exit evidence:** provider-specific signed-fixture tests plus real smoke tests before a channel is described as operational.

### P2 — Build the platform business around the open Core

- [ ] Preserve the MIT Core and clearly separate implemented features from roadmap items.
- [ ] Validate hosted-service demand before building unnecessary cloud infrastructure.
- [ ] Add hosted execution, team/organization controls, usage accounting, audit retention and enterprise deployment only with tested isolation and transparent costs.
- [ ] Publish reproducible capability evaluations for coding, research, files, browser, data, automation and security.

**Exit evidence:** measured task success, cost/latency, human-intervention rate, regression data, and explicit deployment limitations—not a percentage derived from missing evidence.

## Non-negotiable engineering rules

- Inspect repository status, existing diffs, interfaces, dependencies and tests before every code change.
- Make the smallest additive, backward-compatible change; never rebuild or overwrite working subsystems to match another agent.
- Keep all consequential actions behind the existing policy/approval boundary.
- Never claim a capability, benchmark score, live integration or production readiness without evidence on the exact revision.
- Do not merge or deploy automatically as part of roadmap work; review diffs and CI first.

## Reference

Hermes Agent's public documentation describes skills, persistent memory, messaging/gateway integrations and scheduled tasks. Sofia should adopt useful product patterns, not copy upstream implementations or bypass provenance/license review:

- [Hermes Agent documentation](https://hermes-agent.nousresearch.com/docs)
- [Scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/)
