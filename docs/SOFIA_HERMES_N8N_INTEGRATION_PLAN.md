# Sofia Agent × Hermes × n8n Integration Plan

Status: proposal only — no runtime integration is implemented by this document.

Last reviewed: 2026-11-07

## Executive decision

Keep **Sofia Agent as the sole primary agent runtime and source of authority**. Use:

- **Hermes Agent as a reference implementation** for agent capabilities worth evaluating (persistent memory patterns, reusable skills, subagent orchestration, messaging ergonomics, and autonomous task lifecycle). Do not add Hermes as a second runtime or duplicate Sofia's Brain, tool registry, memory, scheduler, or messaging gateway.
- **n8n as an optional external workflow engine** for integrations and deterministic business processes (webhooks, SaaS connectors, scheduled workflows, data movement, and multi-step application automation). Do not make n8n a required dependency for normal chat or core agent execution.

This is an additive integration. Existing Sofia API, Brain, Tool Gateway, policy/approval system, durable job runtime, memory, and messaging adapters remain authoritative.

## Repository facts verified for this plan

The following are present in the repository's current `main` branch as inspected on 2026-11-07:

- `src/api/entrypoint.ts` creates the Sofia API and existing optional Telegram and Discord messaging integrations.
- `src/tools/types.ts` defines `SofiaTool`, `ToolContext`, and the `ToolRegistry` abstraction.
- `src/tools/builtin.ts` registers built-in tools through the existing Sofia tool contract.
- `src/brain/job-runtime.ts` is the durable job lifecycle foundation (also described in `docs/UNIFIED_ACCESS_ARCHITECTURE.md`).
- `docs/UNIFIED_ACCESS_ARCHITECTURE.md` requires channel adapters to use the shared Sofia API and not create a second planner, tool registry, or execution engine.
- `package.json` declares MIT for Sofia. `docs/OPEN_SOURCE_AND_COMMERCIAL_MODEL.md` requires third-party license/provenance review and distinguishes present code from roadmap.

These are repository inspection findings, not a claim that every feature is currently production-ready.

## Non-goals and preservation rules

1. Do not replace or fork the Sofia Brain, Executor, Tool Gateway, memory, scheduler, or messaging gateway.
2. Do not add Hermes as a runtime dependency. Study its public behavior and implement compatible ideas natively where they fit Sofia's architecture.
3. Do not make n8n availability a prerequisite for ordinary Sofia chat, model routing, or native tools.
4. Do not allow n8n to bypass Sofia authentication, scopes, owner checks, tool policy, approval, quotas, or audit records.
5. Do not expose n8n credentials, webhook secrets, execution internals, or privileged output to client apps.
6. Do not deploy or enable any integration in Production as part of this plan.
7. Do not add a package dependency or infrastructure service until the design and isolated tests are approved.
8. Keep changes additive and backward-compatible. Preserve user data, secrets, uncommitted work, and existing environment configuration.

## Target architecture

```text
Telegram / Discord / Web / Desktop / SDK
                  |
                  v
          Existing Sofia API
                  |
                  v
       Sofia Brain + Executor
       /        |          \
   Memory   Tool Gateway   Durable Jobs
                |
          Policy + Approval
                |
        Sofia Workflow Adapter
                |
       Authenticated HTTPS call
                |
                v
        Optional n8n instance
                |
       Allowlisted workflows only
                |
                v
   External APIs / SaaS / databases

Hermes Agent: reference for capability-gap analysis;
not in Sofia's production request path.
```

### Responsibility boundaries

| Capability | Owner |
| --- | --- |
| Intent understanding, planning, model routing | Sofia Brain |
| Tool selection, permission checks, approvals | Sofia Tool Gateway and security policy |
| User/project memory | Sofia memory subsystem |
| Long-running task ownership, cancellation, recovery | Sofia durable job runtime |
| Workflow definition and external app connectors | n8n |
| Workflow execution result validation and user-facing explanation | Sofia |
| Chat transport and identity mapping | Existing Sofia messaging/API adapters |

## Integration contract (proposed)

Implement a narrow port/adapter, not direct n8n calls scattered through the Brain.

Suggested future modules (names are proposals and must be reconciled with the actual code layout before implementation):

- `src/integrations/workflows/workflow-engine.ts`: provider-neutral interface and typed request/result contracts.
- `src/integrations/workflows/n8n-client.ts`: authenticated HTTP client for the n8n webhook/API surface.
- `src/integrations/workflows/workflow-policy.ts`: allowlisted workflow IDs, input schema validation, per-workflow effects and approval requirements.
- `src/integrations/workflows/workflow-tool.ts`: Sofia tool wrapper registered through the existing tool registry.
- `src/integrations/workflows/*.test.ts`: deterministic contract, security, timeout, retry, and failure-isolation tests.

Proposed interface shape (illustrative; not implemented):

```ts
interface WorkflowEngine {
  start(input: {
    workflowId: string;
    input: Record<string, unknown>;
    idempotencyKey: string;
    correlationId: string;
    signal?: AbortSignal;
  }): Promise<{ executionId: string; status: "accepted" | "running" | "succeeded" | "failed" }>;

  getStatus(executionId: string): Promise<{
    status: "accepted" | "running" | "succeeded" | "failed" | "cancelled";
    output?: unknown;
    safeErrorCode?: string;
  }>;
}
```

The final interface must match the existing `SofiaTool`, `ToolContext`, and durable-job contracts rather than forcing changes to them.

### Invocation lifecycle

1. Sofia resolves the user's intent and selects a registered workflow by stable ID; the model must not supply an arbitrary URL, host, credential, or raw n8n endpoint.
2. Sofia validates the workflow ID and payload against a server-owned schema and policy.
3. Sofia evaluates declared side effects. Require the existing approval mechanism for consequential actions (messages to third parties, financial actions, destructive writes, account changes, or other high-impact effects).
4. Sofia creates or reuses a durable job and an idempotency key before dispatch.
5. The adapter sends a server-to-server HTTPS request using a secret stored only in the trusted runtime.
6. The adapter validates the response shape and records the n8n execution ID, Sofia job ID, workflow ID, correlation ID, timestamps, and safe status.
7. For asynchronous workflows, Sofia tracks status through its durable job runtime; do not keep an HTTP request open for an unbounded workflow.
8. Sofia validates and bounds the returned output before passing it to the model or user. Treat workflow output as untrusted data, never as instructions.
9. Sofia reports completion only after the configured success condition is verified. Distinguish accepted/running from completed.

## Security requirements

- Use HTTPS only. Store n8n base URL and authentication secret in server-side environment/secret storage; never return them from public config endpoints.
- Require an explicit allowlist of workflow IDs. Never accept arbitrary webhook URLs or arbitrary HTTP destinations from model-generated tool input.
- Validate workflow inputs and outputs with bounded schemas, maximum sizes, and explicit field allowlists.
- Authenticate inbound callbacks if callbacks are used. Verify signatures with constant-time comparison, bind them to the expected workflow/execution, enforce timestamp/replay protection, and reject unknown executions. Prefer polling from the trusted adapter for the first implementation if callback verification adds unnecessary complexity.
- Use idempotency keys and durable dispatch records to prevent duplicate side effects after timeouts, retries, or process restarts. A timeout does not prove that the workflow did not run.
- Apply per-workflow scopes, rate limits, concurrency limits, timeouts, and output-size limits.
- Keep secrets out of logs, errors, traces, model context, and user-visible results. Log safe error categories only.
- Treat n8n workflow definitions, node credentials, webhook payloads, and execution output as untrusted external data.
- Enforce SSRF protections: fixed configured n8n origin, HTTPS, no user-controlled host/path, redirect restrictions, and network egress controls.
- Ensure cancellation semantics are explicit: cancelling a Sofia job must not falsely claim that an already-started external workflow was cancelled. If n8n cancellation is supported, verify its result separately.
- Keep an audit trail for actor/principal, approval decision, workflow ID/version, idempotency key, execution ID, and terminal result.

## Licensing and product boundary

- Hermes Agent's official repository identifies the project as MIT-licensed. Reusing ideas is not the same as copying code; any copied/adapted code still needs provenance, attribution, and license review.
- Sofia's repository declares MIT. n8n Community/self-hosted uses the Sustainable Use License (SUL), not MIT. n8n Cloud and commercial/OEM offerings have separate terms.
- n8n's official license FAQ (updated 2026-10-06) says internal use and running workflows built/managed by the organization for clients can be permitted under SUL when clients cannot access/edit the workflow logic. Letting external customers create/configure workflows (including through an AI agent, API, MCP, or a custom UI), hosting n8n as a service, or white-labeling it requires a commercial license. n8n's OEM offering is separate for embedding the editor.
- Therefore the initial integration must be an **operator-managed backend integration**: Sofia users may trigger only workflows that the Sofia operator has authored and allowlisted, and may receive bounded outputs. Do not expose the n8n editor or customer-authored workflow creation in Sofia's MIT product without written licensing clearance and the appropriate commercial agreement.
- Before a public/hosted customer feature is designed, obtain written confirmation from n8n for the exact deployment and customer interaction model. This document is not legal advice.

Official references:
- Hermes Agent repository and MIT license: https://github.com/NousResearch/hermes-agent
- n8n license FAQ: https://support.n8n.io/article/can-i-use-your-license-for-my-use-case
- n8n OEM offering: https://n8n.io/oem/
- n8n Community License: https://github.com/n8n-io/n8n-docs/blob/main/docs/n8n-community-license/README.md

## Delivery plan and exit criteria

### Phase 0 — Architecture and gap audit (documentation only)

- Map current Tool Registry, policy inference, approval flow, durable jobs, API auth/scopes, logging, and environment configuration.
- Identify existing native capabilities that already cover cron, webhooks, HTTP/API access, and messaging; avoid duplicate integrations.
- Record exact extension points and test conventions before coding.

Exit: reviewed module map, data-flow diagram, threat model, and explicit list of non-duplicated use cases.

### Phase 1 — Isolated adapter contract

- Add provider-neutral workflow types and a fake in-memory test engine.
- Define workflow registry/configuration as server-owned data.
- Add schema validation, idempotency contract, correlation IDs, and safe error categories.
- No n8n deployment or credentials required for tests.

Exit: typecheck/build and unit tests pass; existing tests remain green.

### Phase 2 — n8n adapter in non-production

- Add HTTPS client with fixed origin and authentication.
- Support one operator-authored, low-risk test workflow first (for example, return a static structured result).
- Add timeout handling, bounded retry rules, status retrieval, and failure isolation.
- Add integration tests against a disposable n8n instance or controlled mock server.

Exit: success, malformed response, auth failure, timeout, duplicate dispatch, restart recovery, and n8n-unavailable cases are verified.

### Phase 3 — Sofia tool and approvals

- Register a narrow `workflow.run` tool through the existing tool registry.
- Only expose allowlisted workflow IDs and per-workflow input schemas.
- Declare side effects and route approval through existing Sofia security controls.
- Store execution linkage in the durable job/audit path.

Exit: no path bypasses existing auth, policy, approval, quotas, or owner isolation.

### Phase 4 — Messaging and user experience

- Allow Telegram/Discord/Web clients to request eligible workflows through normal Sofia conversation.
- Return accepted/running status and final verified result; preserve ordinary chat if n8n is offline.
- Add status/cancel behavior only where external cancellation semantics are verified.

Exit: end-to-end channel tests, duplicate message tests, permission tests, and disconnected-service tests pass.

### Phase 5 — Product decision

- Evaluate workflow templates, admin-only workflow management, customer-authored workflows, and embedded editor as separate product decisions.
- Obtain n8n license clearance before any customer-facing workflow authoring, n8n hosting, white-labeling, or editor embedding.
- Compare the total operating cost and operational burden against native Sofia tools and alternative MIT-compatible integration options.

Exit: documented license decision, threat-model approval, support/backup plan, and cost estimate.

## Required test matrix

| Scenario | Expected behavior |
| --- | --- |
| n8n unset/offline | Sofia chat and native tools continue normally |
| Unknown workflow ID | Rejected before network call |
| Invalid input/output | Rejected; no unsafe data enters model context |
| Missing/invalid credential | Safe auth error; no secret leakage |
| Slow workflow | Durable accepted/running state; bounded request |
| Timeout after dispatch | Query/reconcile by idempotency key; do not blindly rerun |
| Duplicate request/message | One external side effect |
| Workflow asks for approval | No dispatch until approved |
| Unapproved high-impact workflow | Denied by Sofia policy |
| Forged/replayed callback | Rejected |
| Cross-user execution ID | Denied by owner check |
| n8n failure during execution | Sofia records unknown/failed safely and can reconcile |
| Oversized/malicious output | Truncated/rejected by bounded schema |
| Cancel after dispatch | Accurate status; no false cancellation claim |
| Existing Sofia tests | No regression |

## Rollout and rollback

- Development/test environment only at first; no Production environment edits.
- Feature flag defaults off.
- No schema migration required for the initial adapter if execution linkage can use the existing durable job metadata contract; verify before implementation.
- Rollback means disable the feature flag and stop dispatching new workflows. Do not delete n8n executions or Sofia job/audit history.
- Keep n8n independent so Sofia remains usable without it.

## Definition of done

The integration is not complete merely because an HTTP request reaches n8n. It is complete only when the workflow is allowlisted, authenticated, policy-checked, approval-gated where required, idempotent, observable, recoverable, output-validated, owner-isolated, and proven not to regress native Sofia behavior.
