# Sofia Agent Setup Wizard — Architecture and Implementation Plan

## Status

Design baseline only. This document does not claim that a cross-platform wizard has been implemented. The current `main` CLI exposes `sofia init`, `sofia run`, and `sofia status`; it does not yet expose a first-run setup wizard or interactive `sofia chat`. The separate draft PR #278 contains local setup/chat work and multi-platform integration work, but it remains unmerged and needs validation at its current head. Reconcile with that work before implementing overlapping functionality.

## Goals

- Make first-time setup understandable to non-expert users and usable from a phone or desktop.
- Reuse the existing Sofia Core, model gateway, policy gateway, session/memory stores, skills, and messaging gateway; do not create a second runtime.
- Separate local self-hosted configuration from hosted multi-user configuration.
- Validate each step, explain failures in plain language, and let the user retry without restarting the whole wizard.
- Keep secrets server-side where applicable; never return API keys in API responses or logs.
- Make provider/model choice an implementation detail when using a hosted Sofia service, while allowing self-hosted owners to configure their own provider.
- Keep all steps optional where safe and preserve backward compatibility for existing environment-based deployments.

## User-facing flow

1. **Welcome / mode**
   - `Use hosted Sofia`: connect to an already deployed Sofia API.
   - `Run Sofia locally`: configure the user's own runtime and model provider.
   - Never imply that local setup configures a hosted account or that a local key applies to other users.
2. **Connection**
   - Hosted: API base URL and a user-scoped Sofia API key.
   - Local: local runtime endpoint/config location, then provider configuration.
   - Normalize URL, require HTTPS for remote endpoints, and allow HTTP only for explicitly recognized localhost development URLs.
3. **Model provider (local/self-hosted only)**
   - Provider protocol and endpoint, model ID, API key.
   - Secret input is masked. Never prefill a secret from logs or expose it after saving.
   - Validate configuration shape first, then offer a user-triggered connection test. Do not silently switch providers or models.
4. **Storage and memory**
   - Show where state will be stored and whether it is persistent.
   - Default to a private per-user state directory; validate an explicitly configured absolute path.
   - Explain that container/ephemeral storage may be lost and that file-backed state is single-process unless the store implementation says otherwise.
   - Memory is scoped to the authenticated user/session. Treat retrieved memories and transcripts as untrusted context.
5. **Capabilities**
   - Show browser, terminal, filesystem, Git, scheduled jobs, and skill-learning capabilities as capability summaries, not as blanket permission grants.
   - Keep the existing Policy Gateway and per-tool approval semantics authoritative. Setup must not bypass or broaden permissions.
6. **Chat integrations**
   - Present only integrations implemented in the selected build and mode.
   - For each integration show prerequisites, callback/webhook setup, required server-only credentials, user/chat allowlists, a connection check, and a clear status.
   - Never ask users to paste bot tokens into a shared/public chat. Do not mark an integration connected until its provider handshake or webhook verification actually succeeds.
   - Unsupported platforms are labeled “planned” rather than appearing as working options.
7. **Verify and finish**
   - Run safe checks: config readability/permissions, API health, model configuration validity, store initialization, and selected integration readiness.
   - Provider calls that can incur cost require an explicit “Test connection” action.
   - Display a redacted summary and next steps. Never print secret values.

## Proposed internal structure

Keep the wizard as an orchestration/presentation layer over existing services:

- `SetupCoordinator`: owns step order, resumable progress, and error-to-guidance mapping; does not execute agent tasks.
- `SetupStateStore`: stores non-secret progress only. Secrets belong in the existing secure config/secret mechanism, not the progress record.
- `SetupEnvironment`: identifies local CLI, desktop, hosted web, or first-party chat setup; exposes supported capabilities without duplicating runtime logic.
- `SetupChecks`: small typed checks for URL/config validation, storage, API health, provider handshake, and integration verification. Checks return structured status and safe user-facing messages.
- `SetupAdapter`: thin presentation adapter for CLI prompts, desktop UI, and web UI. All adapters call the same coordinator and checks.
- Existing owners remain authoritative:
  - model routing and provider configuration stay in the model/config gateway;
  - tool access stays in ToolGateway/Policy Gateway;
  - sessions and memory stay in the existing stores;
  - messaging setup stays in the existing Messaging Gateway and API entrypoint;
  - scheduling stays in the existing durable job runtime.

Do not introduce a parallel `AgentRuntime`, `ToolRegistry`, `SessionStore`, `MemoryStore`, `Scheduler`, or policy implementation.

## Suggested module boundaries

Names are proposals, not existing modules. Confirm repository conventions and dependency direction before creating files.

```text
src/setup/
  types.ts             # SetupMode, SetupStep, CheckResult, safe error types
  coordinator.ts       # step progression and retry/resume
  checks/
    config.ts          # non-secret schema and URL validation
    storage.ts         # state directory/store readiness
    api.ts             # Sofia API health/auth check
    provider.ts        # explicit, user-triggered provider handshake
    integrations.ts    # delegates to existing gateway-specific verifiers
  adapters/
    cli.ts             # prompts and terminal presentation only
    shared.ts          # reusable presentation-neutral helpers
```

Only add modules that are justified by the existing codebase. Desktop and web adapters should be added when their actual entrypoints are inspected; do not create speculative UI packages as part of the first slice.

## Data contracts (conceptual)

- `SetupStepStatus`: `pending | in_progress | passed | needs_attention | skipped`.
- `SetupCheckResult`: stable check ID, status, safe summary, actionable remediation, optional retryable flag. No secret values, raw provider response bodies, or unfiltered exception messages.
- `SetupProgress`: schema version, selected mode, completed step IDs, timestamps, and non-sensitive selections only.
- Persisted setup progress must be versioned and tolerate unknown future fields. It must not contain API keys, bot tokens, raw authorization headers, or model prompts.

## Security and reliability requirements

- Inspect permissions and path-containment helpers already in use; reuse them instead of reimplementing.
- Use owner-only file/directory permissions on POSIX and documented platform-appropriate protection elsewhere.
- Never write secrets to progress files, telemetry, diagnostics, test snapshots, or CLI output.
- Avoid logging raw HTTP response bodies, callback URLs with tokens, or provider exception strings that may contain credentials.
- Require explicit user action for billable provider tests and external integration verification.
- Do not weaken allowlists, origin validation, webhook signature verification, secret environment filtering, or workspace symlink protections.
- Use idempotent writes and safe atomic replacement where supported. Do not delete or migrate existing state during setup.
- A failed step must not erase previously valid settings. Validate a proposed value before replacing the stored value.
- Do not connect a production deployment or change production environment variables as part of the wizard implementation.

## Implementation slices

1. **Recon and overlap resolution**
   - Compare current `main`, PR #278, and PR #279 at their exact latest heads.
   - Reconcile shared-file overlaps before adding code; do not merge either PR automatically.
2. **Core contracts and pure validation**
   - Add typed step/result contracts and deterministic URL/config validation.
   - Add tests for invalid URLs, missing fields, unknown step IDs, safe error redaction, and progress versioning.
3. **CLI first-run experience**
   - Build a thin wizard over the existing CLI/runtime; preserve `init`, `run`, and `status`.
   - Add retry, cancellation, resume, and non-interactive mode with clear missing-input errors.
4. **Storage/provider checks**
   - Reuse the existing state directory and model gateway. Keep provider calls opt-in and explicit.
5. **Messaging integration setup**
   - Add a platform only when its existing integration supports a real verification path; enforce server-side secrets and allowlists.
6. **Desktop and web adapters**
   - Reuse the same coordinator after identifying their real entrypoints. Do not duplicate setup logic.
7. **Verification and release**
   - Run focused tests, full repository tests, typecheck, build, security checks, and cross-platform CI.
   - Report exact commit SHA and exact checks that passed. Keep changes in a draft PR until review and combined-branch CI are green.

## Acceptance criteria

- A new user can choose hosted or local mode and receives distinct, accurate instructions.
- Invalid configuration produces a safe actionable message and preserves the last valid configuration.
- Secrets never appear in setup progress, API responses, logs, screenshots, or test output.
- Provider tests are never called implicitly and no silent provider fallback occurs.
- Setup does not bypass existing policies or grant tools automatically.
- Existing CLI commands and environment-based deployments remain compatible.
- Tests cover cancellation, retry, resume, redaction, path/URL validation, and configuration-write failure.
- UI status is evidence-based: “connected” only follows a successful real check; otherwise it says “not tested” or “needs attention”.
