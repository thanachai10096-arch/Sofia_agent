# Sofia Agent Coordination — Implementation Roadmap

Status date: 2026-10-15
Scope: safely evolve the current coordination protocol into a real multi-agent capability without bypassing Sofia's existing execution and security controls.

## Current verified boundary

The current branch contains an in-memory, bounded agent message protocol and a delegation authorizer, plus regression tests and a security design note. The Brain's bounded single-specialist failure-recovery hook routes its task/result exchange through a per-run message bus and authorizer. Messages are snapshotted at publication and revalidated when consumed. The authenticated principal is now carried in host-owned task scope and checked by the delegation authorizer when that scope is principal-bound. Workspace-root binding, full job ownership enforcement, cancellation-race integration proof, persisted trace/recovery, feature-flag rollout, and full end-to-end safety proof remain outstanding. Do not advertise multi-agent orchestration as generally available until the gates below pass.

## Non-negotiable invariants

- **Human task only:** every agent run is rooted in a user-authorized job with a stable job ID, objective, deadline, and budgets. Agents may not invent unrelated work or continue after cancellation/deadline.
- **No authority escalation:** agent messages, model output, peer agreement, retrieved documents, and tool output cannot grant permissions, modify policy, expose secrets, disable auditing, or revive a kill switch.
- **One execution gateway:** all side effects go through the existing Tool Gateway and its authorization, approval, and sandbox controls. A proposal is not an action.
- **Least privilege:** each specialist receives only the tools needed for its assigned task, further intersected with parent-job scope and host policy.
- **Untrusted by default:** all inter-agent payloads and evidence are data, never system instructions. Delimit and label them; reject requests to reveal secrets, ignore policy, or perform out-of-scope work.
- **Bounded execution:** cap depth, fan-out, queued messages, concurrent agents, model calls, tokens/cost, tool calls, wall-clock time, and retries. Exhaustion fails closed.
- **Auditable lifecycle:** record parent job, agent identity/role, delegation reason, policy decision, evidence references, tool approvals, outcomes, cancellation, and verification. Redact credentials and sensitive content.
- **Verified completion:** agent claims are not proof. Brain independently verifies acceptance criteria and reports remaining uncertainty.

## Phased delivery gates

### Phase 0 — Harden the primitives (P0)

- [x] Add typed message envelope and bounded in-memory message bus.
- [x] Add parent-scope and host-granted capability checks for delegation.
- [x] Add regression tests for scope, freshness, payload size, duplicate IDs, queue limits, privileged tools, and delegation budgets.
- [x] Snapshot queued messages to prevent post-validation mutation; re-check message freshness and job deadline on consumption.
- [x] Reject malformed/non-finite hop values and invalid delegation budgets at runtime.
- [x] Run npm ci, npm run license:check, npm run typecheck, npm test, and npm run build in CI; workflow run #945 passed all 6 jobs after the workflow-plan store changes. Cross-platform Windows/macOS/Ubuntu, browser egress, and Docker sandbox integration jobs passed.
- [x] Review message-size and budget configuration validation, including invalid limits, bounded envelope metadata, evidence ID caps, and policy-snapshot regression tests.
- [x] Make host-level privileged-tool denials non-overridable by caller-supplied delegation policy; added regression coverage for permissive policy attempts. CI run #945 passed.
- [x] Add a standalone `FileWorkflowPlanStore` and a minimal workflow-plan factory; the current branch does not contain a workflow orchestrator, so these files are not yet wired into Brain or job execution. The store adds atomic durable writes, schema checks on read, owner-only local permissions, exclusive fail-closed run locks, serialized snapshot replacement within one process, and store/lock/concurrent-write regression tests. GitHub Actions run #945 passed all 6 jobs, including Ubuntu/macOS/Windows typecheck, tests and builds plus browser egress and Docker sandbox integration.

**Exit criteria:** required CI green on Ubuntu, macOS, and Windows; tests reproducibly pass; no claim of runtime integration yet.

### Phase 1 — Wire into the real Brain (P0)

- [x] Trace the existing SofiaBrain, SubagentRuntime, ToolGateway, and DurableJobRuntime paths before editing production flow.
- [x] Route the bounded single-specialist recovery exchange through a per-run coordinator owned by Brain; no independent tool-execution route is created.
- [ ] Complete coordinator binding to authenticated principal, active job ID, allowed tools, workspace boundary, cancellation signal, and deadline (principal scope/authorizer matching implemented; Brain specialist path still needs trusted workspace-root propagation and end-to-end job ownership/cancellation proof).
- [x] Add a standalone sequential `WorkflowOrchestrator` with durable checkpoints, owner-principal matching, trusted absolute workspace-root input, exclusive run lock, dependency ordering, explicit approval pause/resume, and cancellation checks. Its execution callback is an integration seam and MUST route side effects through Brain/Tool Gateway; it is not yet wired into `SofiaBrain` or `DurableJobRuntime.
- [x] Add workflow DAG validation, persisted-plan schema/cycle validation, guarded step transitions, evidence references, and conservative retry assessment (no automatic retries).
- [x] Validate specialist result envelopes at the Brain boundary: expected role, non-empty bounded summary, plain-object action input, bounded reason, JSON serializability, and a 16 KiB proposal cap. Reject malformed output before it can be considered for execution.
- [x] Route the bounded Brain specialist exchange through the ACP message bus and explicit delegation authorizer, with run identity and deadline scope bound by host-owned state.
- [x] Carry the host-authenticated principal into specialist task scope and deny delegation requests whose principal does not match a principal-bound scope.
- [ ] Derive and enforce the workspace root from the trusted workspace runtime; do not accept a workspace root from model or agent payloads.
- [ ] Keep action execution exclusively in Brain/Tool Gateway; subagents cannot call tool implementations directly.
- [ ] Ensure cancellation/deadline closes the bus, aborts model work, and prevents queued proposals from executing.
- [ ] Persist enough trace state to explain the job after restart; explicitly decide whether queued messages are replayed or discarded. Never replay side effects without idempotency checks.

**Exit criteria:** end-to-end test proves a user task reaches a specialist and returns evidence; a proposal executes only after normal policy approval; cross-job and cancelled-job messages cannot execute.

### Phase 2 — API, identity, and durable isolation (P0)

- [ ] Associate every job and message with authenticated owner/principal and tenant/workspace; verify ownership on get/list/resume/cancel.
- [ ] Prevent IDs from becoming an insecure direct object reference; a guessed job ID must not expose another principal's state.
- [ ] Add per-principal and per-job concurrency, fan-out, token/cost, model-call, tool-call, and wall-clock budgets.
- [ ] Make message deduplication and task transitions durable and race-safe; test concurrent submit/resume/cancel.
- [ ] Define restart semantics and idempotency keys for any side effect; default uncertain in-flight actions to review rather than automatic replay.
- [ ] Ensure persistence redacts secrets and has restrictive filesystem permissions.

**Exit criteria:** integration tests for two principals, ownership violations, restart, duplicate submissions, cancellation races, and budget exhaustion.

### Phase 3 — Prompt-injection and runaway-agent defense (P0/P1)

- [ ] Add hostile-message tests: prompt injection in workspace files, web pages, peer output, and tool errors.
- [ ] Add a typed evidence envelope with provenance, trust level, source, timestamp, and size limit.
- [ ] Use explicit role contracts and narrow task prompts; never pass a peer message as privileged instruction.
- [ ] Add loop detection using parent/child lineage, repeated task fingerprints, no-progress detection, and bounded replanning.
- [ ] Enforce a global kill switch that can stop new delegations and all side effects without relying on an agent's cooperation.
- [ ] Require human approval for destructive file/system actions, credential access, external publishing, purchases, and other high-impact operations as defined by policy.

**Exit criteria:** adversarial suite shows prompt injection cannot widen scope, bypass approval, reveal secrets, or continue after kill/cancel.

### Phase 4 — Evaluation and controlled rollout (P1)

- [ ] Build deterministic fake-agent tests before live-model tests.
- [ ] Measure task success, acceptance-criteria pass rate, unauthorized-action attempts, policy denials, cost, latency, retries, and cancellation latency.
- [ ] Compare single-agent baseline to multi-agent runs; disable delegation where it worsens quality/cost.
- [ ] Add a feature flag defaulting off; enable only for explicitly supported jobs after all prior gates pass.
- [ ] Publish limitations, supported roles, budget defaults, audit behavior, and safe failure modes in user docs.

**Exit criteria:** documented benchmark and security results, all critical tests passing, and an explicit release decision.

## Suggested implementation order

1. Run CI for the workflow lifecycle/orchestrator changes; do not claim those new changes pass until the run is green. The store and orchestrator remain separately callable primitives until an explicit Brain/DurableJobRuntime integration is implemented.
2. Map the real Brain/subagent/Tool Gateway/job-runtime call graph and add an architecture test harness.
3. Integrate a single specialist round trip behind a feature flag; no parallel fan-out at first.
4. Add cancellation, permission-denial, hostile-evidence, and cross-principal tests.
5. Add durable trace/recovery semantics and budget enforcement.
6. Only then add bounded parallel specialists and production rollout.

## Release rule

If any permission, identity, ownership, cancellation, budget, or verification check is uncertain, fail closed and ask the user or stop. Never let agent consensus overrule Sofia's host policy.
