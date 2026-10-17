# Sofia Agent security and reliability audit

**Snapshot date:** 2026-10-17  
**Scope:** Current `main` source plus explicitly identified open pull requests. This is an engineering audit snapshot, not a security certification or production-readiness claim.

## Existing mainline controls observed

- `src/security/policy.ts`: network, shell, and destructive operations default to disabled. Unknown registered tools are classified as destructive unless effects are explicitly declared. Production configuration requires capability/audit secrets and an allowed-host list when network/browser access is enabled.
- `src/security/guard.ts`: path traversal and secret-file checks, prompt-injection heuristics for control fields, risk classification, and basic secret redaction exist.
- Browser runtime and egress proxy: the repository documents DNS validation/pinning, private/internal destination blocking, HTTP/HTTPS port restrictions, and disabled direct-network bypass paths. These are important controls and must not be weakened.
- `src/sandbox.ts`: Docker-backed container isolation is opt-in. Process execution mode is not an OS-level sandbox.
- `src/brain/job-runtime.ts`: durable local job records, cancellation, snapshots, and resume exist. The built-in JSON state store is local-filesystem persistence, not a multi-host transactional queue.
- `src/platform/cloud-execution.ts`: `CloudExecutionBackend` is an interface and `LocalJobBackend` is the only production implementation in main. This is not remote/cloud execution support.

## Findings and required gates

### P0 — Merge and release discipline

1. **Do not infer integrated correctness from a green feature-branch CI run.** Each feature branch must pass CI at its exact head, then the integrated branch must rerun CI after merges.
2. **Do not merge all open PRs at once.** Many changes touch the public export barrel or core runtime. Merge sequentially, inspect each diff, and rerun regression tests after every integration.
3. Keep production security controls authoritative at dispatch. Planner hints, skill metadata, MCP annotations, and subagent proposals are not permissions.

### P0 — Secrets and untrusted tool output

- Mainline `redactSecrets` in `src/security/guard.ts` provides basic labelled/Bearer redaction. Review and validate PR #117, which expands redaction coverage for provider-token formats and sanitizes tool outputs/errors/audit events. Until that change is integrated and validated, do not assume all unlabelled token formats are redacted.
- Redaction is defense in depth. Tools should not be permitted to read secret files in the first place, and external tool results must remain untrusted.
- Any MCP integration must pass tool calls through Tool Registry / Tool Gateway / policy, and should treat server names, schemas, annotations, resources, and output as untrusted.

### P0 — Browser, shell, and sandbox boundaries

- Preserve browser egress restrictions and host/container egress controls. Live browser tests must include private/reserved IPs, DNS rebinding, redirects, IPv4/IPv6 edge ranges, and non-standard ports.
- Do not describe `ProcessSandbox` as OS isolation. Use the configured container boundary for stronger isolation, and keep Docker security options and immutable image digests.
- Shell and destructive tools must remain denied by default and require explicit policy/approval. Never infer authorization from an agent's plan or a skill's declared capabilities.

### P0 — Durable jobs and concurrency

- The current file-backed job store is local. It must not be represented as a multi-host queue or exactly-once external side-effect guarantee.
- PRs #95 and #101 address local-filesystem write serialization, claims, leases, and worker fencing. Review their limitations and exact-head CI before merge; a lease alone does not make external side effects exactly once.
- Add crash-injection tests for admission, cancellation, terminal persistence failures, resume races, stale worker writes, and duplicate external actions before production multi-worker use.

### P1 — Messaging and identity

- PR #129 is an opt-in Messaging Gateway foundation stacked on PR #104. Its documented boundaries matter: provider signatures must be verified against the raw request body before parsing, identity mapping must be trusted, allowlists must fail closed, and attachments must not be downloaded without a separate guarded downloader.
- Keep the master Sofia API key server-side. Do not treat a transport-neutral dispatcher as a complete live webhook integration.

### P1 — Skills and learning

- The existing learning/evolution signals are heuristic evidence, not model training and not permission grants.
- PR #122 distinguishes runnable handlers from planned catalog entries; planned entries must not be advertised as implemented.
- Candidate skill promotion must require explicit evaluation evidence, policy checks, and rollback. The new versioned lifecycle work remains opt-in until it is integrated with the actual learned-skill path and reviewed.
- Persistent skill registries using a local file are single-process only; use a transactional shared store for multi-process deployment.

### P1 — Subagents

- Existing in-process specialist calls produce proposals, and Brain/Tool Gateway must remain responsible for validation and side effects.
- A bounded coordinator primitive is not the same as full Brain-integrated task decomposition. Host factories must create fresh child contexts and least-privilege tool sets. Parent verification is mandatory before applying child output.

### P2 — Voice, evaluation, and remote execution

- Voice support is optional and provider-agnostic unless an actual STT/TTS provider is configured. Validate real media duration independently; metadata alone is not proof.
- Batch evaluation should default to one worker when cases share a workspace. Trajectory exports may contain sensitive information even after redaction.
- A cloud backend interface or mock contract test is not a remote execution service. Do not claim remote execution until a real provider, workload isolation, authentication, quotas, cancellation, artifacts, and monitoring are validated.

## Required CI/release checklist

- [ ] Exact PR head passes license check, typecheck, full tests, and build.
- [ ] Cross-platform tests pass on supported Windows/macOS/Linux and supported Node versions.
- [ ] Docker sandbox integration and Playwright browser-egress integration pass.
- [ ] Negative tests cover permission denial, untrusted tool output, secret redaction, cancellation races, persistence failure, restart recovery, and duplicate side-effect prevention.
- [ ] Review the complete diff against the latest main and verify no existing API, feature, test, or user data was removed.
- [ ] Refresh readiness documentation against the final integrated commit; do not copy CI evidence from an older head.
- [ ] Complete source/dependency/license provenance review before release.

## Current conclusion

Sofia has meaningful policy, browser-egress, sandbox, job-recovery, and verification foundations. The main remaining risk is not simply missing features: it is **integration evidence**. Feature branches and open PRs are not part of main until merged, and a green feature-branch run does not prove the combined system is correct. Merge incrementally, preserve fail-closed behavior, and require CI on the final integrated head.
