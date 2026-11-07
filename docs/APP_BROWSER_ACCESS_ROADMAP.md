# Sofia App & Browser Access Roadmap

**Status:** implementation plan; capabilities are not considered production-ready until the acceptance evidence below is recorded.
**Scope:** extend the existing Sofia Agent architecture. Do not replace the Brain, Tool Gateway, Browser Runtime, Desktop runtime, policy, or approval system.

## Goals

Sofia must be able to use websites and approved applications as an agent: authenticate through a user-controlled flow, preserve isolated sessions, perform bounded actions, request approval for sensitive side effects, verify outcomes, and report failures honestly.

## Existing implementation to preserve

- Playwright-backed `PlaywrightBrowserRuntime` with a DNS-pinned local egress proxy, URL checks, redirect/subresource checks, and private-network/metadata blocking.
- Browser tools for open, navigation, click, type, select, scroll, wait, keypress, history, reload, observation, screenshots, and close.
- Central Tool Registry / `RegistryToolGateway`, security effects, policy checks, approvals, audit, and kill-switch behavior.
- Desktop runtime, capability model, native driver contract, loopback pairing authority/action host, and operator-controlled app allowlist.
- API authentication and scope mapping. User-provided request JSON must never grant itself capabilities.

## P0 — Isolation and lifecycle

1. Create browser tool handles per Brain run, not in the process-wide dependency registry.
2. Keep pages, cookies, storage state, downloads, and browser context scoped to an authenticated principal and an explicit profile.
3. Close contexts and revoke ephemeral handles on run completion, cancellation, timeout, and shutdown.
4. Ensure tool calls cannot address another run's page ID, even if the model guesses an identifier.
5. Add concurrency tests with two principals/runs and prove no cross-run navigation, page lookup, cookie, or screenshot access.
6. Preserve the egress proxy and test public navigation plus private-IP, metadata, redirect, DNS rebinding, and subresource denial.

**Acceptance:** parallel runs have distinct context IDs and page namespaces; cross-run access is denied; every lifecycle terminal path closes the owned context; no browser credential appears in model context, logs, events, or API responses.

## P1 — User-controlled browser login and profiles

**Implementation slice in progress:** owner-scoped local profile directories, persistent visible Playwright login handoff, profile listing/revocation tools, and run-scoped cleanup are being added on a dependent branch. This is not enabled by default and is not a Railway/cloud login feature.

Local Desktop opt-in requires all of:
- `SOFIA_BROWSER_LOGIN_ENABLED=true`
- `SOFIA_BROWSER_HEADLESS=false`
- `SOFIA_BROWSER_PROFILE_DIR=<private local directory>`
- A local graphical session (Windows/macOS or Linux with DISPLAY/WAYLAND_DISPLAY)
- An authenticated `principalId` and the existing browser policy enabled

The profile store hashes owner IDs for directory partitioning, uses opaque UUID profile IDs, applies owner-only directory/file permissions, and exposes only profile IDs/timestamps to the model. Chromium's persistent user-data directory contains site session data (including cookies) on disk; it is not application-layer encrypted by this implementation. Use OS full-disk encryption and a local user account, do not place the profile directory on shared/network storage, and revoke profiles when no longer needed. Railway must not set these opt-in variables.


1. Add an explicit profile manager with opaque IDs, owner binding, status, timestamps, and lifecycle operations.
2. Login happens in a visible, user-controlled browser window or an approved local companion. Sofia must not ask the user to paste passwords, one-time codes, cookies, or bearer tokens into chat.
3. Keep profile data in an operator-configured private directory with owner-only filesystem permissions, encryption at rest where a supported key provider exists, and no cloud sync by default.
4. Never expose raw cookies, localStorage, sessionStorage, browser storageState, or credential files to the model or tool output.
5. Profiles are opt-in, per principal, revocable, and never shared across users. Profile export/import is disabled unless an explicit encrypted operator workflow is implemented.
6. Require re-authentication when a site expires or requests step-up authentication. Never bypass CAPTCHA, MFA, device trust, or site access controls.

**Acceptance:** create/login/use/revoke profile flow tested with two principals; persisted profile files have restrictive permissions; logs and model transcripts contain no credential material; revoked/expired profiles cannot launch a page.

## P2 — App Connector and OAuth Registry

1. Define a typed connector contract: provider ID, required scopes, authorization URL, callback validation, token refresh, revoke, health, and supported actions.
2. Use OAuth Authorization Code + PKCE for public clients where supported; validate state, issuer, redirect URI, audience, and token expiry.
3. Store tokens in a dedicated secret store abstraction; never in source control, plain JSON, prompts, tool descriptions, or logs.
4. Grant least-privilege scopes and show the user the provider and requested permissions before consent.
5. Expose provider actions as typed tools through the existing registry and policy gateway. Mark read, write, destructive, and external-send effects accurately.
6. Start with a small set of high-value connectors and add providers only with documented scopes, tests, and revocation support. Do not claim universal app access.

**Acceptance:** OAuth state/PKCE/redirect/replay/expiry/refresh/revoke tests; tenant/user isolation; scope-denial tests; secrets redaction tests; sandbox provider integration test. Live provider operation requires a separate real-credential smoke test.

## P3 — Desktop and local app access

1. Keep native input on a local user-owned host; cloud Railway must never be treated as the user's desktop.
2. Pair using short-lived one-time code and scoped token; bind pairing to the local user, origin, and allowed capabilities.
3. Add signed installers and OS-specific packaging for Windows, macOS, and Linux; request OS accessibility/screen-recording permissions only when needed.
4. Resolve app IDs through operator-configured executable mappings; do not let the model provide arbitrary executable paths or shell commands.
5. Require a real out-of-band confirmation for app launch, click, typing, keypress, file writes, and other side effects.
6. Keep remote control disabled until the local bridge, transport authentication, origin checks, token storage, revocation, and OS permission UX pass live tests.

**Acceptance:** real-machine smoke test on each supported OS; unauthorized origin and expired/revoked pairing denied; approval denial prevents input; helper process receives no Sofia secrets; screenshots and typed text are bounded and redacted.

## P4 — Unified task execution and verification

- All browser and app actions use the same Brain → Tool Gateway → Policy → Approval → Audit path.
- Ordinary chat does not trigger browser/app use unless the task requires it.
- The Brain plans multi-step work, asks only for missing essential details, pauses for approvals, observes the resulting state, verifies the requested outcome, and recovers safely.
- Treat page content, app content, files, and connector responses as untrusted data, never as instructions that override system policy.
- Detect login walls, MFA, CAPTCHA, permission errors, network blocks, expired sessions, and unsupported actions; report the actual blocker.
- Prevent duplicate external side effects using idempotency keys where the provider supports them.

**Acceptance:** E2E fixtures for research, sign-in handoff, read-only account lookup, approved form submission, approval denial, session expiry, network denial, duplicate delivery, timeout, cancellation, and process restart. Every claim must cite the test or live smoke evidence.

## P5 — Operations and release

- Metrics: successful/failed login handoffs, context creation/cleanup, connector health, approval wait time, action verification, and policy denials; never log secrets or raw sensitive page contents.
- Document retention, deletion, profile revocation, incident response, and recovery.
- Run typecheck, unit tests, build, CI OS matrix, security scans, and live integration tests separately.
- Merge only focused PRs after checks pass. Back up and verify Railway state before any production deployment. No automatic production deployment is part of this roadmap.

## Delivery sequence

1. Run-scoped browser isolation (first implementation slice).
2. Context lifecycle cleanup and per-principal profile storage.
3. User-visible login handoff and secure profile revocation.
4. OAuth/connector contract and first provider.
5. Desktop local host packaging and real-machine validation.
6. End-to-end task evaluation and staged release.

## Non-goals and hard boundaries

- No universal credential scraping, cookie extraction, CAPTCHA/MFA bypass, or hidden login automation.
- No shared browser profile across users.
- No arbitrary cloud-to-desktop remote control.
- No blanket OAuth scopes or model-controlled permission escalation.
- No claiming that a connector or app works until its integration tests and live smoke evidence support that claim.
