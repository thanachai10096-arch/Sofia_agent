# Hermes Architecture Study and Sofia Adoption Plan

Study target: `NousResearch/hermes-agent` (upstream main, inspected 2026-11-07).
Sofia target: `thanachai10096-arch/Sofia_agent` (main at `4fe3cc8` during the audit).

This is a source-level comparison, not a claim that Hermes is failure-free. Hermes is a mature, broad agent runtime; its architecture and recovery patterns are useful references, but its Python implementation should not be copied wholesale into Sofia's TypeScript runtime.

## 1. Hermes architecture observed in source

### One agent runtime behind multiple entry points
- `run_agent.py` is the public `AIAgent` facade.
- `agent/conversation_loop.py` and focused `agent/turn_*.py` modules implement a single conversation turn lifecycle.
- CLI, messaging Gateway, ACP, batch runner, and library entry points all call the same agent runtime.
- The internal transcript has one canonical message representation (system/user/assistant/tool); provider adapters translate to and from chat-completions, Codex Responses, and Anthropic Messages formats.

Relevant source: `website/docs/developer-guide/architecture.md`, `website/docs/developer-guide/agent-loop.md`, `agent/conversation_loop.py`.

### Gateway is transport, authorization, session routing, and delivery
- Platform adapters normalize incoming events.
- Gateway authorizes the sender, resolves a stable session key, loads session history, invokes the shared agent, then delivers the final response.
- Session lifecycle is separated from platform transport.
- The gateway has explicit recovery semantics for interrupted/unknown turns; it does not blindly replay work when side effects may already have happened.

Relevant source: `website/docs/developer-guide/gateway-internals.md`, `website/docs/developer-guide/gateway-session-lifecycle.md`, `gateway/session.py`, `gateway/run.py`.

### Provider resolution is shared and explicit
- `hermes_cli/runtime_provider.py` is the common provider resolver for CLI, gateway, cron, ACP, and auxiliary model calls.
- Resolution uses explicit selection/configuration/environment/default precedence.
- Provider API mode is resolved independently from the agent loop; provider adapters normalize their wire formats back to the canonical transcript.

Relevant source: `website/docs/developer-guide/provider-runtime.md`, `hermes_cli/runtime_provider.py`.

### Context is a lifecycle concern, not only an admission gate
- Preflight estimates include the system prompt, messages, and tools.
- Context management runs before model calls and may compress/prune older history while protecting recent turns and tool-call structure.
- Compression has bounded retries/timeouts and explicit handling for malformed, empty, truncated, or overloaded summarizer output.
- Prompt stability/caching is treated as an invariant; ephemeral turn notes are injected without mutating the stable prompt prefix.

Relevant source: `agent/turn_context.py`, `agent/context_compressor.py`, `agent/context_compressor_prune.py`, `agent/conversation_compression.py`, `website/docs/developer-guide/context-compression-and-caching.md`.

### Recovery is classified and bounded
- API failures are classified before retry/fallback decisions.
- Retry, credential rotation, context overflow recovery, fallback, interrupt, and terminal failure are distinct paths.
- Tool calls and results remain in the canonical transcript; partial side effects are not misreported as if nothing happened.
- Retry budgets and interruptible backoff prevent unbounded loops.

Relevant source: `agent/turn_api_error.py`, `agent/turn_recovery.py`, `agent/turn_overflow.py`, `agent/error_classifier.py`.

## 2. Sofia current architecture observed

Sofia already has important foundations and should retain them:
- `src/brain/executor.ts`: explicit understand → plan → execute → observe → verify → diagnose/replan loop, bounded model/tool/token/time budgets, checkpointing, approvals, rollback hooks, subagents, learned skills, and evidence-based verification.
- `src/brain/token-aware-gateway.ts` and `src/brain/token-budget.ts`: route admission, budget reservation/settlement, provider usage checks, timeouts, route circuit state.
- `src/models/gateway.ts`: OpenAI-compatible and Anthropic Messages adapters, request cancellation, concurrency gates, provider circuit handling.
- `src/integrations/messaging/sofia-handler.ts`: normalized messaging dispatch and ordinary-language input support.
- Telegram and Discord adapters call the existing Brain through API/job runtime boundaries; keep their authorization and deduplication controls.

## 3. Important gaps identified

1. **Understanding schema had no repair path.** `SofiaBrain.understand()` called `parseUnderstanding()` directly. By contrast, plan/replan already had one bounded schema-repair attempt in `inferValidatedPlan()`. A malformed `ambiguities` value could therefore terminate a run before planning. This is the production error pattern reported by the user.
2. **Core context cannot currently be packed down.** `TokenAwareGateway.packContext()` checks the fixed core prompt first and only ranks/adds evidence after the core fits. If core alone is too large, every route rejects it as `contextTooLarge`. Dropping old observations in `SofiaBrain.infer()` does not compact task, project context, tool descriptions, or the core state.
3. **The token estimator is heuristic.** `estimatePromptTokensUpperBound()` is explicitly not a mathematical upper bound. Provider-reported usage is authoritative, but admission can still be inaccurate for different tokenizers, tool schemas, images, and provider-specific message wrappers. Route admission and the exact serialized request need a shared accounting contract.
4. **Brain is more schema-driven than Hermes' conversational loop.** Every request is forced through structured phase JSON, including simple conversational questions. That gives Sofia strong execution control, but creates avoidable failure modes for ordinary chat and makes provider JSON behavior a critical dependency.
5. **Transport unification is incomplete at the product surface.** Telegram and Discord use shared dispatch pieces, but their runtime lifecycles differ (API Run polling vs durable Job polling). Discord's current interaction transport is not equivalent to arbitrary Discord channel-message support.

## 4. Adoption plan — preserve Sofia, import proven patterns

### P0 — make the current Brain resilient
- Repair malformed understand output once, with bounded error and output preview; then validate again and fail closed if still invalid.
- Apply the same explicit repair contract to every structured phase, with phase-specific validators and a shared retry budget.
- Preserve tool authorization, effect checks, approval requirements, principal ownership, and evidence verification during every recovery attempt.
- Add tests for malformed JSON, wrong field types, truncated output, empty output, retry exhaustion, abort during repair, and model-call budget exhaustion.

### P0 — context packing and compression
- Introduce a context packer that measures the exact provider-bound request shape (system/instructions, task, acceptance criteria, state, tool schemas, history, evidence).
- Keep task and acceptance criteria protected; compact or rank optional context first.
- Add deterministic pruning before LLM summarization; keep a protected recent tail and never split assistant tool-call/result pairs.
- If summarization is used, validate its output, cap attempts/time, preserve original source data, and record a summary lineage/checkpoint. Never replace the only copy of original evidence.
- Reject only after all safe packing/compression options are exhausted; report which budget dimension caused rejection.

### P1 — canonical conversation runtime
- Introduce a transport-neutral turn interface shared by Telegram, Discord, Web/API, Desktop, and future adapters.
- Keep platform adapters responsible only for identity verification, authorization, normalization, session-key resolution, and delivery.
- Unify run/job lifecycle behind one durable turn contract without removing existing run IDs, job IDs, status, cancellation, resume, dedupe, or notification recovery.
- Add explicit per-session serialization/queue semantics and unknown-turn recovery to prevent duplicate side effects after process restart.

### P1 — shared provider runtime
- Centralize provider/model/protocol resolution and health/fallback policy.
- Keep OpenAI-compatible, Anthropic Messages, and future provider adapters at the edge of the canonical internal request/response model.
- Persist the selected provider/model identity with the run so retries/resumes do not silently change semantics.
- Validate capability claims (tool use, reasoning, vision, context window) from configuration/metadata rather than assuming all models behave alike.

### P2 — Hermes capabilities only where Sofia lacks tested equivalents
- FTS5 session recall and summarized cross-session search.
- Stable prompt layers and prompt-cache-aware context injection.
- Skill lifecycle evaluation and promotion/rollback.
- Scheduled agent jobs with durable delivery and timezone/retry/misfire handling.
- Subagent orchestration and tool execution improvements where tests show measurable benefit.

## 5. Non-goals and safety invariants

- Do not replace Sofia with Hermes or copy Hermes wholesale.
- Do not remove Sofia's verified loop, security controller, tool effect policy, approval gates, owner scoping, path/symlink protections, secret redaction, run store, or durable job state.
- Do not replay a turn after restart when tool side effects may have happened unless the execution record proves replay is safe.
- Do not call a task successful because a model said it succeeded; require Sofia's verification evidence.
- Do not deploy a broad runtime rewrite without unit, integration, recovery, and real Telegram/Discord end-to-end tests.

## 6. First implementation in progress

PR #402 adds the missing one-shot understanding-schema repair, matching the bounded plan-repair pattern. It includes a regression test using the observed `ambiguities: string` response shape. The change remains fail-closed if the repaired output is invalid.
