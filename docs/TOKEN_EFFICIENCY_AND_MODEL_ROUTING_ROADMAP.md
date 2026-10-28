# Sofia Agent: Token Efficiency and Model Routing Roadmap

Status: implementation plan anchored to the current repository. Items labeled "planned" are not claims of implemented behavior.

## Objective

Minimize the cost and compute used per successfully verified task while preserving task quality, security, user data boundaries, and cancellation/recovery behavior. Do not optimize raw token count at the expense of correctness.

## Current foundation verified in the repository

- `src/brain/token-budget.ts`: per-run and per-model token/cost/call/concurrency reservations, settlement against reported usage, and fail-closed behavior when usage is unknown.
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
- Establish deterministic tests for route selection, evidence packing, budget settlement, unknown usage, cancellation, and provider failure.
- Run the offline evidence-packing fixture in CI; treat its tokenizer estimate separately from real provider usage and verified task outcomes.
- Do not publish a savings percentage until the same benchmark suite has a valid baseline and comparison run.

**Exit gate:** typecheck, unit tests, build, and CI results reported separately for the exact commit; no benchmark claims without stored results.

### P1 — Lower waste in the existing gateway

- Pack evidence by relevance-to-size value; reject empty evidence and duplicate IDs.
- Deduplicate byte-for-byte identical evidence text without normalizing source code or whitespace.
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
- The harness still compares synthetic tasks with manually compacted evidence; invoking `TokenAwareGateway` in a full Brain task loop remains a separate benchmark milestone.
