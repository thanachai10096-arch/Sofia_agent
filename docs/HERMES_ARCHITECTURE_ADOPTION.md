# Hermes architecture study and Sofia adoption plan

This document records an implementation-oriented comparison with the upstream
[Hermes Agent architecture guide](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
and [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop).
It is an adoption guide, not a claim that Sofia already implements every Hermes feature.

## Hermes patterns verified in upstream documentation

Hermes uses one `AIAgent` facade across CLI, gateway, ACP, batch and API entry
points. The core owns prompt construction, provider resolution, tool dispatch,
context management, retries/recovery and persistence. Platform adapters create
a normalized message event, authorize the sender, resolve a session, call the
same agent loop and deliver the response.

The upstream architecture guide identifies these subsystems:

- Agent loop: `run_agent.py`, `agent/conversation_loop.py`, and focused
  `agent/turn_*.py` phases.
- Provider runtime: one provider resolver shared by gateway, CLI, cron, ACP and
  auxiliary model calls; adapters cover multiple API wire formats.
- Context engine/compression: pluggable context engine and bounded summarizer.
- Tools: central registry, toolset grouping, dispatch and error wrapping.
- Sessions: SQLite + FTS5, session lineage and per-platform isolation.
- Gateway: normalized platform events, authorization, session routing,
  delivery, hooks and maintenance.
- Reliability principles: observable, interruptible execution; stable prompt
  prefixes; profile isolation; optional subsystems behind extension points.

## Sofia's existing foundations

Sofia already has a state-machine Brain in `src/brain/executor.ts` with
understand/plan/execute/observe/verify/diagnose/replan, token limits,
checkpoints, resume, approval-aware tools, and evidence-gated workflow memory.
The model gateway in `src/brain/token-aware-gateway.ts` performs route
eligibility, context packing, metered reservations and bounded provider calls.
`src/brain/token-aware-reasoner.ts` converts the executor envelope into a
bounded prompt contract. Messaging adapters and shared dispatch live under
`src/integrations/messaging/`.

The right migration is to strengthen these seams, not replace Sofia's security,
durable-job or verification model with a second runtime.

## Gaps to close, in priority order

1. **Consistent structured-output recovery.** Understand and plan are model
   generated structured phases. A malformed response should receive one
   bounded repair attempt with the exact validation error and a truncated
   invalid response. The repaired value must pass the same parser and policy
   validation. Do not coerce unknown objects, invent risk values, or guess tools.
2. **One canonical conversational execution path.** All adapters should
   normalize inbound events and call the same core dispatcher, with stable
   principal/conversation session keys and authorization rechecked at dispatch.
3. **Context lifecycle.** Separate stable system instructions, dynamic trusted
   configuration, and untrusted conversation/evidence. Rank and pack evidence
   under the route's actual context window; summarize only with provenance and
   preserve recent turns, task intent, acceptance criteria and tool results.
4. **Provider runtime parity.** Centralize provider/model/base URL/protocol
   resolution and error normalization. Explicit user-selected routes must not
   silently switch; automatic routing may use only configured eligible routes.
5. **Tool registry and observability.** Keep tool schemas, policy checks,
   approvals, execution, cancellation and result normalization consistent.
   Record safe progress events and actionable error categories without logging
   secrets or untrusted prompt contents.
6. **Session and recovery durability.** Preserve authenticated user/platform
   isolation, durable job ownership, deduplication and restart recovery.
   Avoid claiming multi-replica safety while stores are process-local.

## Current implementation slice

The current branch adds one bounded retry around malformed Understand output.
It sends the parser error and a maximum 4,000-character response preview back
to the model with explicit field constraints, then runs the original strict
parser again. The global model-call budget still applies; a second malformed
response fails closed. It does not bypass tool authorization or change
risk classification.

Regression coverage verifies that a malformed list-valued field is repaired
once and the run can proceed through trusted verification.

## Acceptance gates before production

- Typecheck, unit suite, build, license checks and platform CI pass.
- Regression tests prove one repair maximum, no repair after cancellation,
  strict risk enum validation, no unregistered tool execution, and model-call
  budget enforcement.
- Preview deployment passes health checks and structured logs show the
  expected run lifecycle without sensitive prompt data.
- Real Telegram and Discord smoke tests confirm inbound event, same-session
  dispatch, completion and outbound delivery. CI alone is not an end-to-end
  messaging test.
- Production deploy only after these gates; retain existing persistent state,
  security policy and rollback path.

## Upstream references

- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop
