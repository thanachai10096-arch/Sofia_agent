# Sofia × n8n Adapter — Phase 0 Code Audit

Status: repository inspection only; no runtime code changed.
Reviewed: 2026-11-07
Repository: `thanachai10096-arch/Sofia_agent`
Baseline inspected: `main`

## Executive finding

Sofia already has a strong extension seam: register a `SofiaTool` and let `RegistryToolGateway` enforce schema validation, policy, risk assessment, approval, capability checks, cancellation, and audit logging. The n8n adapter should enter through this seam.

However, a naïve `workflow.run` tool with `effects: ["network"]` will currently be denied by the existing security guard unless the assessed action contains an explicit URL that passes `SOFIA_ALLOWED_HOSTS`. The model must not be allowed to supply that URL. This is the first concrete design issue to solve before writing the adapter.

A second issue is lifecycle: `DurableJobRuntime` persists Sofia Brain jobs and checkpoints, but it does not currently model an external n8n execution ID, external execution state, or reconciliation/idempotency ledger. Do not assume that a normal Brain job record alone provides safe exactly-once external side effects.

## Verified code map

| Concern | Existing code | Verified behavior relevant to n8n |
| --- | --- | --- |
| Tool contract | `src/tools/types.ts` | `SofiaTool` has name, description, JSON-schema-like input schema, optional `ToolEffect[]`, and async execute(input, context). `ToolContext` currently exposes workspace runtime and abort signal only. |
| Tool registration | `src/tools/registry.ts`, `src/tools/builtin.ts` | Registry is a `MapToolRegistry`; built-ins are composed as a list. The factory creates the registry in `src/models/factory.ts`. |
| Tool execution/security | `src/brain/registry-tool-gateway.ts` | Clones/freezes input; validates schema; enforces `allowTools`, tool effects, `assessAction`, max risk, approval, capability checks, kill switch, abort signal, and audit. |
| Effect policy | `src/security/policy.ts` | `network` requires `allowNetwork`; `effectiveToolEffects` defaults undeclared custom tools to destructive; reserved tool names cannot downgrade inferred effects. |
| URL/host guard | `src/security/guard.ts` | Network/browser actions need an explicit HTTP(S) URL in the action input (with exceptions for terminal and certain git operations); each host must match `allowedHosts`. |
| Approval | `src/agent/approval.ts`, `src/brain/registry-tool-gateway.ts` | Approval is bound to immutable input and an action hash. If approval is required but no handler is configured, execution fails closed. `approveAll` is development-only and returns false in production. |
| Audit | `src/security/audit.ts`, `src/models/factory.ts` | Gateway records allow/deny/approval-required/completed/failed. Factory can compose memory and encrypted-file audit when configured. |
| Kill switch | `src/security/controller.ts` | Active tool calls receive a bound abort signal; kill switch blocks new calls and aborts active calls. |
| Durable Sofia jobs | `src/brain/job-runtime.ts` | Persists queued/running/completed/failed/cancelled Brain jobs, owner, leases, heartbeat, snapshots and results; has restart/lease recovery. File store explicitly rejects multi-host lock ownership and requires a transactional shared store for multi-host workers. |
| Runtime composition | `src/models/factory.ts` | Creates builtin/browser tools, policy, approval wiring, registry gateway, Brain and durable job runtime. |
| API/chat composition | `src/api/entrypoint.ts` | Creates existing API and optional Telegram/Discord integrations. n8n should not become a required startup dependency. |
| Tests | `src/brain/registry-tool-gateway.test.ts`, `src/brain/job-runtime.test.ts` | Existing tests cover immutable approval input, kill-switch behavior, tool effect classification, validation-before-execution, and durable job recovery/cancellation. |

## Concrete blockers and design decisions

### B1 — Trusted network target must be assessed without model-controlled URLs

Current behavior:
- `RegistryToolGateway.execute()` passes the model-produced tool input directly into `assessAction()`.
- For `network` effects, `assessAction()` collects URLs from the input and denies the action if no explicit URL is present (for a generic custom tool).
- `SofiaTool.execute()` receives no trusted service configuration or principal metadata beyond the generic tool context.

Required design:
- Keep the model input limited to `workflowId` and bounded `payload`; never accept a URL, hostname, webhook URL, credential, or arbitrary path from the model.
- Add a trusted, server-owned target declaration to the registered tool/descriptor (or an equivalent explicit security metadata port) and have the gateway assess that fixed target against `SOFIA_ALLOWED_HOSTS`.
- The trusted target must come only from validated server configuration; it must not be part of the model-visible input or approval-editable arbitrary URL.
- Add tests proving a model cannot change the target host, scheme, port, or path and cannot use the adapter for arbitrary SSRF.

Do not work around this by declaring the integration read-only or omitting the `network` effect. That would misrepresent the real side effect and weaken policy.

### B2 — Network permission and approval behavior

Current behavior:
- `network` is blocked unless `SOFIA_ALLOW_NETWORK=true`.
- Network risk is high, so `assessAction()` requires approval.
- If no approval handler is configured, `RegistryToolGateway` denies the call.
- Production also requires `SOFIA_CAPABILITY_SECRET`; factory configuration separately requires audit secret under production policy.

Required design:
- Declare n8n workflows with truthful effects (at least network; add write/destructive when the workflow can mutate external systems).
- Use existing approval plumbing; never use `approveAll` in production.
- Use workflow-specific permissions and allowlists. A low-impact read-only workflow may still be network-risky under current guard behavior; any future policy exception must be narrowly designed and tested, not silently assumed.
- Ensure approval is bound to workflow ID/version, normalized payload hash, principal, and exact external side-effect summary.

### B3 — External workflow execution is not the same as a Sofia Brain job

Current behavior:
- `DurableJobRuntime` persists Sofia Brain job lifecycle and Brain snapshots.
- It does not define external workflow execution identity, external idempotency key, n8n status, or reconciliation state.
- Its local file lock is single-host only; it explicitly fails closed for a lock owned by another host.

Required design:
- For the first adapter, either (a) support only bounded synchronous workflows that finish within a strict timeout, or (b) introduce a dedicated durable workflow-execution ledger with unique idempotency key, external execution ID, state transitions, timestamps, and reconciliation.
- Do not blindly retry after an ambiguous timeout: the workflow may already have started and caused an external side effect.
- If long-running workflows are in scope, use the dedicated ledger and a recovery/reconciliation loop; do not hold a Brain tool call open indefinitely.
- Do not expand `JobRecord` or migrate its storage until a separate compatibility and recovery review proves it is necessary.

### B4 — Output is untrusted external content

Required design:
- Validate output against per-workflow response schema, size limits, depth limits, and safe error categories.
- Redact secrets before audit/model/user exposure.
- Treat returned text as untrusted reference data; it cannot override Sofia instructions, tool policy, or approval requirements.
- Never return n8n credentials, internal stack traces, or raw execution internals by default.

### B5 — Runtime availability and deployment isolation

Required design:
- Feature flag defaults off.
- Missing n8n URL/secret means the tool is not registered or is unavailable with a safe message; Sofia chat and native tools must continue.
- No n8n client connection attempt during startup health checks that could make the Sofia API unavailable.
- Start with a disposable development n8n instance or mock HTTP server. Do not add Railway/Vercel production variables or services during adapter development.

## Recommended implementation sequence

1. Add tests for the trusted network target contract and SSRF rejection before implementing the HTTP client.
2. Extend the tool/security descriptor in a backward-compatible way so the gateway can assess a server-owned fixed network target without exposing it to the model.
3. Add a provider-neutral workflow engine contract and fake engine.
4. Add n8n HTTP adapter with fixed origin, HTTPS-only, redirect restrictions, authentication header, strict response validation, bounded timeouts, and safe error mapping.
5. Register one operator-authored, allowlisted, low-impact workflow behind a feature flag.
6. Add idempotency/reconciliation only if asynchronous or side-effecting workflow support requires it; otherwise keep v1 deliberately bounded.
7. Run focused tests, full typecheck, full test suite, and build; report each result independently.
8. Only then consider a separate PR for non-production integration configuration.

## Acceptance tests required before merge

- A model cannot choose or override n8n base URL, host, port, protocol, path, credentials, or arbitrary workflow webhook.
- Unallowlisted host and non-HTTPS target are rejected before network I/O.
- Missing network permission denies execution.
- Missing approval handler fails closed.
- Approval request is bound to immutable workflow ID/version and payload hash.
- Workflow ID is allowlisted and payload schema is enforced.
- Invalid/oversized/deep output is rejected before model context.
- Timeout after dispatch does not cause blind duplicate dispatch.
- Duplicate idempotency key does not create a second external execution.
- n8n offline/unconfigured does not affect ordinary Sofia chat or native tools.
- Cancellation and kill switch are propagated accurately.
- Audit records redact credentials and include correlation identifiers.
- Existing RegistryToolGateway and DurableJobRuntime tests remain green.

## Scope and evidence limits

This audit is based on source files fetched from the repository's `main` branch on the review date. It is not a local test run, CI result, live n8n integration test, or deployment verification. No code, dependency, environment variable, runtime configuration, or Production service was changed by this audit.
