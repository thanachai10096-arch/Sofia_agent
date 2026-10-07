# Sofia Agents

Sofia is a single-agent orchestration layer designed to use multiple AI models behind one user-facing Agent.

The user does **not** choose a model. Sofia classifies the task, scores available model routes, delegates work when useful, verifies results, and falls back or escalates when a model fails.

## Architecture

```
User
  -> Sofia Orchestrator
      -> Task Router
      -> Model Router
      -> Agent Worker
      -> Tools / Workspace
      -> Reviewer
      -> Retry / Escalation
  -> Final result
```

### Core principles

- One Agent identity, many internal models.
- Model choice is an internal policy, never a user-facing selector.
- Capability, complexity, latency, cost, health and task history influence routing.
- Tools are permissioned; the model never receives raw secrets.
- Failed work can retry on another route or escalate to a stronger route.
- Reviewer output can reject a result and trigger another attempt.
- The model layer is provider-agnostic so OpenAI, Anthropic, Google and other providers can be connected later through one gateway/adapter.

## Project layout

- `src/agent/` — orchestration and task lifecycle
- `src/models/` — internal model registry/router and provider contract
- `src/tools/` — permissioned tool registry
- `src/security/` — execution policy
- `src/review/` — result verification
- `src/index.ts` — public runtime entry point

## Internal routing example

```text
"Fix the TypeScript build and test it"
        |
        +--> coding task / high complexity
        |
        +--> coding model
        |
        +--> tools: files + terminal
        |
        +--> reviewer
              |
              +--> PASS -> finish
              |
              +--> FAIL -> retry/escalate
```

No model name is exposed by the Agent API.

## Run

This repository currently contains the orchestration core and provider contracts. Connect a real model provider through the `ModelProvider` interface, then expose `SofiaAgent.run()` through the Zuse web app API.

```bash
npm install
npm run typecheck
npm test
```

## Sofia Experience Layer

Sofia is designed for both non-developers and professional developers.

The default user experience is **simple**: users describe the outcome they want in natural language. Sofia keeps model selection, planning, tool routing, verification, repair, memory, and learned skills internal.

```text
User intent
   ↓
Sofia understands
   ↓
Plans + builds
   ↓
Tests + verifies
   ↓
Repairs when needed
   ↓
Learns from successful repairs
   ↓
Plain-language progress
```

Three presentation modes are supported:

- `simple` — outcome-focused progress with no implementation jargon.
- `guided` — progressively explains what Sofia is doing.
- `pro` — suitable for developer-facing clients that want deeper execution detail.

The experience layer does **not** change model routing or execution safety. It only changes how Sofia communicates its work.

API clients can send:

```json
{
  "task": "สร้างระบบสมาชิกให้เว็บนี้",
  "experience": {
    "mode": "simple",
    "explainProgress": true
  }
}
```

Streaming clients receive both engineering events and a small human-readable `progress` event stream.