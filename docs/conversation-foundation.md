# Sofia Conversation Foundation

This module is a provider-independent foundation for natural-language conversations. It remains a separate module so it can be integrated into Sofia Core without duplicating the existing agent planner or tool gateway.

## Included

- Owner-scoped conversation sessions and message history.
- User, assistant, and tool-result message types; public API clients may submit user messages only.
- Bounded message length, history length, list size, and model-context size.
- Context assembly that preserves the newest contiguous messages in chronological order.
- Session clear and delete operations.
- An in-memory store for tests and a file-backed JSON store for single-process local deployments.
- Optional authenticated HTTP endpoints, enabled by passing `conversationStore` to `SofiaApiConfig`.

## Local API integration

Use `createSofiaLocalApi` when running one local API process and you want persistent file-backed conversations and run records without wiring the stores manually:

```ts
import { createSofiaAgentDependencies, createSofiaLocalApi } from "sofia-agent";

const deps = createSofiaAgentDependencies(/* provider/model configuration */);
const server = createSofiaLocalApi(deps, {
  apiKeys: {
    [process.env.SOFIA_API_KEY!]: ["agent:run", "agent:read"],
  },
});
server.listen(3000, "127.0.0.1");
```

Set `SOFIA_STATE_DIR` to an absolute persistent directory, or pass `{ stateDirectory: "/path/to/state" }` as the third argument. The factory creates `api-runs/` and `conversations/` beneath that directory. It preserves any explicit `runStore` or `conversationStore` passed in the config. This factory enables conversation endpoints intentionally; `createSofiaApi` remains opt-in and returns `503` for conversation routes when no store is supplied.

Do not expose a local API on a public interface without appropriate authentication, origin policy, TLS/network controls, and permissions. File-backed stores are single-process only and are not suitable for multi-replica/serverless deployment.

## HTTP API

All routes require a Bearer API key. The owner ID is derived from the authenticated key hash; the client cannot select another owner.

- `GET /v1/conversations` — list the authenticated owner's sessions (`agent:read` or `agent:run`).
- `POST /v1/conversations` — create a session (`agent:run`); optional JSON `title`.
- `GET /v1/conversations/:id` — retrieve an owned session (`agent:read` or `agent:run`).
- `POST /v1/conversations/:id/messages` — append a user message; JSON `{ "role": "user", "content": "...", "async": true }` (`agent:run`). Use `async: true` to return a run ID and poll URL immediately; omit it for synchronous compatibility.
- `GET /v1/conversations/:id/turns/:runId` — poll the authenticated owner's async turn status/result (`agent:read` or `agent:run`).
- `GET /v1/conversations/:id/turns/:runId/stream` — replay the bounded recent event history and stream new run events using SSE. Disconnecting does not cancel the run; reconnect with the same URL or poll the status endpoint. The stream closes when the run reaches a terminal state.
- `DELETE /v1/conversations/:id/messages` — clear message history (`agent:run`).
- `DELETE /v1/conversations/:id` — delete an owned session (`agent:run`).

If no conversation store is configured, these routes return `503 conversation_store_unavailable`. A turn runs synchronously within the HTTP request, bounded by the configured request timeout and API usage limiter. Prior conversation context is capped by the conversation service and again at 12,000 characters in Brain; it is labeled as untrusted reference material and must not override system instructions, security policy, or the current task. Async turns reuse the API's existing run lifecycle, concurrency limits, cancellation, usage limiter, run persistence, and ownership checks. For both ordinary async runs and async conversation turns, the initial queued run record must be saved before work starts; if that write fails, the API returns `503 run_persistence_unavailable`. The terminal record is also awaited before the run releases its per-key concurrency slot, draining queued event/status writes first; terminal persistence failures do not erase the in-memory result and remain a durability limitation. Async conversation admission also best-effort rolls back the just-appended user message and refunds the consumed run quota. This is an admission guard, not a transaction spanning the conversation store and run store; if the conversation store itself fails during rollback, manual reconciliation may still be needed. Run events are bounded to the latest 500 entries and are included in the configured run store. Reconnectable SSE is available at the turn stream endpoint; clients can also poll if SSE is unavailable. A server restart marks queued/running runs as interrupted according to the existing run-store recovery behavior; this is reconnectable status, not guaranteed execution continuation.

## SDK usage

The TypeScript SDK exposes the same endpoints for web, desktop, and mobile clients:

```ts
const conversation = await client.createConversation("Project chat");
const accepted = await client.sendConversationMessage(conversation.id, "Inspect this project", {
  async: true,
});
if ("pollUrl" in accepted) {
  const turn = await client.waitForConversationTurn(
    conversation.id,
    accepted.run.id,
    { timeoutMs: 30 * 60 * 1000 },
  );
  console.log(turn.assistantMessage?.content ?? turn.error);
}
```

For live progress, call `openConversationTurnStream(conversation.id, runId, signal)` and parse the returned SSE response body. Keep the API key in a trusted host/server; do not embed a master key in a public browser or mobile bundle.

## Security and trust boundaries

- Derive ownership from authenticated credentials. Never trust an owner ID supplied by an untrusted client.
- Missing and non-owned sessions have the same not-found response.
- Clients cannot forge assistant or tool messages through the conversation API.
- Tool outputs are untrusted evidence, not system instructions.
- Do not store credentials, API keys, or secrets in conversation history.
- The file-backed store uses atomic file replacement and restrictive POSIX permissions where supported. It is intended for one process on a trusted local filesystem.
- For multi-process, serverless, or cloud deployment, implement a transactional database-backed `ConversationStore` and test access control, durability, concurrency, and deletion semantics.

## Remaining production work

The conversation API, async turns, bounded execution events, polling, reconnectable SSE, and run/conversation references are implemented in this foundation. The local file-backed implementation is intentionally single-process.

Before production multi-user or cloud deployment:

1. Implement a transactional shared database-backed `ConversationStore` and durable queue; do not share the local JSON store across replicas.
2. The async `/v1/agent/runs` admission path awaits the configured run store before returning `202 Accepted`; storage errors return `503 run_persistence_unavailable`. This improves persistence guarantees but is not a transactional queue handoff: the local file store remains single-process, and the run store and scheduler are not one atomic transaction.
3. Add explicit recovery/requeue semantics only when execution checkpoints and idempotent tool actions are available. Until then, restart recovery marks in-flight runs failed as interrupted; it does not claim to resume them.
4. Add load, crash-injection, and concurrent-writer tests for the production storage adapter.
5. Keep API credentials server-side for browser clients and retain Sofia Core's permission, approval, cancellation, usage-budget, ownership, and secret-filtering enforcement.
