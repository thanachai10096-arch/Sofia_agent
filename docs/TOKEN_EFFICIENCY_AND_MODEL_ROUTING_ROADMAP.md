# Sofia Agent: Token Efficiency and Model Routing Roadmap

Status: implementation plan anchored to the current repository. Items labeled "planned" are not claims of implemented behavior.

## Objective

Minimize the cost and compute used per successfully verified task while preserving task quality, security, user data boundaries, and cancellation/recovery behavior. Do not optimize raw token count at the expense of correctness.

## Current foundation verified in the repository

- `src/brain/token-budget.ts`: per-run and per-model token/cost/call/concurrency reservations, settlement against reported usage, and fail-closed behavior when usage is unknown or actual input/output usage exceeds its reservation. Overruns are fully charged and stop further calls rather than silently undercounting usage.
- `src/brain/token-aware-gateway.ts`: phase-specific input/output caps, evidence packing, capability/quality eligibility, estimated-cost routing, cancellation, and safe provider error categories.
- `src/brain/task-efficiency-metrics.ts`: privacy-safe in-memory aggregation for per-task token usage, model-call counts, duration percentiles, verification outcomes, and estimated cost when explicitly supplied. `SofiaBrain` records successful model-call usage/duration, flags failed or unreported usage as incomplete, aggregates built-in subagent usage when reported, and emits a per-run measurement through the optional `onEfficiencyMeasurement` host callback. Durable JSONL persistence is opt-in with `SOFIA_EFFICIENCY_METRICS_ENABLED=true`; records are namespaced by workspace and principal, and contain only aggregate usage/verification metadata. A dashboard and benchmark savings claim are not included yet. Cached-token counts and actual provider billing remain unknown unless an integration supplies them. The authoritative budget remains `TokenBudget`.
- `src/brain/model-route-adapter.ts`: adapts existing model routes into the token-aware Brain gateway.
- `src/models/config.ts`: now supports an explicit registry of OpenAI-compatible provider endpoints via `SOFIA_PROVIDER_IDS` and per-provider base URL/API key/model variables, with optional per-route provider/model selection. Existing Gemini environment configuration remains backward compatible. The registry does not silently fall back across providers; providers using a different API protocol still need a dedicated adapter and tests.
- `src/models/gateway.ts`: provider request timeout, concurrency gate, retry handling for selected transient errors, and circuit-breaker behavior. Successful Brain-call telemetry includes retries before a successful response; failed calls without returned usage are counted as unmeasured rather than assigned fabricated tokens.
- `src/brain/executor.ts`: execution limits, trace, verification, recovery, skills, memory, and subagent integration.
- `bench/token-efficiency.mjs`: offline synthetic-tokenizer regression benchmark for the real `TokenAwareGateway` evidence packer. It asserts high-relevance evidence survives and compares estimated input tokens against a naive unfiltered prompt; this is not a live-provider cost or end-to-end task benchmark.

These are foundations, not proof of measured savings or production readiness. The current configuration should not be described as a universal multi-provider registry.

## Efficiency principles

1. **Optimize cost per verified success.** Track correctness and regression alongside token use.
2. **One Core, one budget.** Web, desktop, mobile, SDK, and chat adapters must use the same Brain, Tool Gateway, policy, and accounting path.
3. **Model choice is policy-bound.** Support a user-selected single model and smart routing among explicitly enabled models. Never send prompts to an unapproved provider.
4. **Known prices before heuristics.** Use configured provider prices where available. If estimated costs tie, use deterministic configured route weights rather than silently relying on array order.
5. **No speculative model fan-out.** Do not call several models merely to compare answers unless the user or a measured workflow explicitly requests it.
6. **Context is selected, not dumped.** Preserve system instructions, task requirements, security constraints, and relevant evidence; remove duplicate evidence and prefer useful compact evidence.
7. **Tools before repeated reasoning.** Use deterministic local tools for exact operations where safe, and send concise, relevant results back to the model.
8. **Cache only within safe boundaries.** Cache keys must include the necessary user/workspace/version/parameters and permission scope. Never share private results across users.
9. **Bound recovery, not user ambition.** Execution safety controls prevent runaway retries and duplicate side effects; they must not impose arbitrary task-size limits unrelated to policy or resource protection.
10. **No unverified learning promotion.** Learned skills/workflows require evaluation, versioning, and rollback before becoming trusted defaults.

## Delivery plan

### P0 — Evidence-backed baseline

- Record the exact commit, configuration, provider/model, and task fixture for each benchmark.
- Measure reported input/output usage, cached usage when the provider exposes it, model calls, retries, latency, completion result, and verified task success.
- Separate measured provider cost from estimates; label missing prices or usage explicitly.
- Aggregate cost and cost-per-verified-success remain unknown when any task in the comparison set has unknown cost; expose known-task counts separately rather than presenting a partial sum as a complete total.
- Establish deterministic tests for route selection, evidence packing, budget settlement, unknown usage, cancellation, and provider failure.
- Run the offline evidence-packing fixture and deterministic Brain-loop benchmark in CI; the Brain-loop benchmark now reports a naive full-context baseline beside the packed prompt estimate and asserts the baseline is larger. Treat both as synthetic character-based estimates, not provider-billed usage or real-world savings.
- Do not publish a savings percentage until the same benchmark suite has a valid baseline and comparison run.

**Exit gate:** typecheck, unit tests, build, and CI results reported separately for the exact commit; no benchmark claims without stored results.

### P1 — Lower waste in the existing gateway

- Pack evidence by relevance-to-size value; reject empty evidence and duplicate IDs.
- Rank task context using whole-token overlap rather than substring matches (for example, `token` must not match `tokenizer`) and ignore common English stop words, so generic wording is less likely to boost unrelated evidence into the input budget.
- Avoid serializing task/context/reference-context fields twice: keep the task and acceptance criteria in the prompt core, and send prior context only through ranked evidence chunks.
- Deduplicate byte-for-byte identical evidence text before source labels are added, including repeats arriving through caller context, project context, and retrieved memory; do not normalize source code or whitespace. Prefer the duplicate source with stronger task relevance and never treat truncated-prefix matches as identical.
- Keep phase-specific output caps and use actual usage to settle reservations.
- When estimated prices tie or are absent, use explicit cost/latency/quality weights with deterministic tie-breaking.
- Add regression tests for quality-preserving context selection and routing determinism.

**Exit gate:** new tests pass on the exact branch and measured benchmark results show no task-quality regression.

### P2 — Provider and model registry

- Introduce a provider adapter contract and a registry of explicitly enabled provider/model configurations.
- Track each model's capabilities: structured output, tool use, vision, context window, cancellation, usage reporting, and pricing metadata.
- Support three explicit policies: fixed model, user-selected allowed model, and smart routing among the user's allowed models.
- Keep credentials server-side; support custom OpenAI-compatible endpoints only with explicit user configuration.
- Make cross-provider fallback opt-in and visible in policy. Never silently send sensitive data to another company.
- Validate provider response schemas, usage fields, timeout semantics, and error categories independently.

**Exit gate:** provider contract tests and privacy/fallback tests pass for each supported provider. A model is supported only after its tests pass.

### P3 — Context, memory, and cache

- Retrieve only task-relevant user/project memories and label their provenance and trust level.
- Summarize old conversation context with a reversible reference to the source, while retaining critical instructions and evidence.
- Filter tool output at the boundary: return the needed rows/lines/errors, not entire files or logs by default.
- Use provider prompt caching when supported and cache stable prompt prefixes before dynamic task content.
- Add scoped deterministic tool-result caching with explicit freshness/invalidation rules.
- Measure cache hit rate and saved billed tokens; never assume cached tokens are free unless provider pricing confirms it.

**Exit gate:** tests cover freshness, invalidation, user/workspace isolation, secret redaction, and prompt-injection handling.

### P4 — Learning and workflow optimization

- Record successful and failed strategies, usage, duration, and independent verification outcomes.
- Recommend reusable skills from repeated successful tasks; do not automatically promote untrusted skill/code changes.
- Evaluate proposed skills against held-out fixtures, compare regressions, version them, and support rollback.
- Reuse prior verified workflow steps only when repository state, permissions, and task preconditions still match.

**Exit gate:** controlled evaluations show improved cost or time per verified success without a regression in task quality or unsafe-action rate.

### P5 — Platform-wide consistency

- Expose a common usage/trace view across API, SDK, web, desktop, mobile, Telegram, Discord, and future channels.
- Attribute all model calls—including retries and subagents—to the parent run and principal.
- Enforce per-user/per-workspace quotas and cost ceilings on hosted deployments while allowing self-hosted operators to configure their own policy.
- Keep user-facing chat natural; commands such as `/run` are optional channel-specific affordances, not a requirement for ordinary chat.

## Required measurements

- Verified task success rate and acceptance-criteria pass rate.
- Input, output, and cached tokens per task where available.
- Actual provider cost and estimated cost, reported separately.
- Cost per verified successful task.
- Model calls, retry count, tool calls, and subagent calls per task.
- Median and p95 latency.
- Recovery success rate and regression rate.
- Unsafe-action rate, permission denials, and cross-user isolation test results.
- Provider compatibility pass rate.

## Safety and compatibility rules

- Preserve existing public interfaces and the immutable Brain contracts unless a separately reviewed migration is approved.
- Extend existing `TokenAwareGateway`, `TokenBudget`, `ModelRouter`, and provider gateway; do not create a second runtime or policy gateway.
- Never log API keys, raw authorization headers, or unredacted sensitive prompts.
- Do not change production deployments or merge this work without review and evidence.
- If usage is missing or invalid, do not claim precise cost or savings.
- Report tests only when actually run; distinguish local checks, CI, provider smoke tests, and live channel tests.


### Usage attribution update

- Parent-task efficiency telemetry aggregates provider-reported usage from the built-in in-process subagent when available.
- Model invocations that fail before returning provider usage are recorded as unmeasured calls. Their presence marks usageComplete=false and prevents cost totals from being presented as complete/known; partial token counts remain visible as partial counts.
- The same marker is used when a custom subagent does not report usage. Custom subagent implementations should return aggregate usage to participate in complete accounting.
- This is observational telemetry only. It does not replace or change authoritative TokenBudget reservations/settlements. Provider billing for failed attempts may remain unknowable unless the provider returns usage for those attempts.


### Live benchmark pricing and attribution update

- The opt-in live benchmark can calculate **estimated** cost and estimated cost per verified success when the operator supplies both input and output prices per million tokens. It does not infer prices from provider/model names or query invoice-level billing.
- Missing usage or missing explicit pricing keeps estimated cost `null`. A token-reduction percentage alone is not a claim of cost savings or end-to-end Sofia task quality.
- The live harness now passes synthetic relevant/noise evidence through Sofia's actual `TokenAwareGateway` packer before sending the selected evidence to the configured provider. It still does not run the full Brain task loop, and its synthetic tasks cannot establish general real-workload savings.


### Live benchmark now exercises the evidence packer — 2026-10-28

- The compact arm in `bench/live-model-efficiency.mjs` now uses the actual `TokenAwareGateway` with a synthetic offline route to select evidence; the baseline arm sends the full synthetic evidence set to the same explicitly configured provider/model.
- The live run still makes six billable-capable provider calls, requires explicit endpoint/key/model, and remains opt-in. Its packing step itself makes no provider calls.
- The harness remains a three-task synthetic smoke benchmark, not the full Brain execution loop. Report observed usage/quality for that run only; do not generalize it to all Sofia workloads.
- Latest workflow runs for this change are in progress; no passing result is claimed until they complete. No live provider calls or production deployment were performed during this change.


### Brain context now enters token-aware evidence packing — 2026-10-28

- `TokenAwareBrainReasoner` now converts the Brain request's recent tool observations, failure diagnoses, execution decisions, compact project context, and retrieved project memory into evidence chunks for the existing `TokenAwareGateway`.
- Evidence is labeled as untrusted reference data in both chunk labels and the model instructions; it is not elevated to trusted instructions. Relevance scoring uses task-term overlap to rank context before packing.
- Added tests that assert historical/project evidence reaches the gateway and that legacy requests without memory remain compatible.
- This closes a context-plumbing gap in the token-aware reasoner, but test/typecheck/CI results for this exact change must be confirmed before treating it as validated. It does not by itself establish end-to-end task savings.


### Offline full Brain-loop benchmark — 2026-10-28

- Added `bench/brain-loop-efficiency.mjs`, which runs a complete deterministic synthetic task through `SofiaBrain`, `TokenAwareBrainReasoner`, `TokenAwareGateway`, tool execution, and acceptance-criteria verification.
- The benchmark emits aggregate model-call usage and verified-task telemetry without logging prompts or responses. Its synthetic route reports a deterministic character-based token estimate; it performs no network/provider calls and does not estimate provider billing.
- Added `bench/brain-loop-efficiency.test.mjs` and wired it into Sofia Benchmark CI. This is a runtime integration regression, not evidence of live-provider token savings. Fresh CI must pass before this exact change is considered validated.


### Context evidence granularity — 2026-10-28

Caller-provided multiline context is now split into individually ranked evidence chunks before TokenAwareGateway packing. Each line receives a stable per-source ID and remains labeled as untrusted reference data. This allows the gateway to retain task-relevant lines without treating a large transcript as a single indivisible evidence item. A regression test covers multiple lines and a later relevant line. This is an internal packing behavior change; it does not change BrainRunInput or public interfaces. Fresh CI is required to validate the latest commit.
