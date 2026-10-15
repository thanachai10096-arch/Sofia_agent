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

If no conversation store is configured, these routes return `503 conversation_store_unavailable`. A turn runs synchronously within the HTTP request, bounded by the configured request timeout and API usage limiter. Prior conversation context is capped by the conversation service and again at 12,000 characters in Brain; it is labeled as untrusted reference material and must not override system instructions, security policy, or the current task. Async turns reuse the API's existing run lifecycle, concurrency limits, cancellation, usage limiter, run persistence, and ownership checks. Run events are bounded to the latest 500 entries and are included in the configured run store. Reconnectable SSE is available at the turn stream endpoint; clients can also poll if SSE is unavailable. A server restart marks queued/running runs as interrupted according to the existing run-store recovery behavior; this is reconnectable status, not guaranteed execution continuation.

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

## Next integration steps

1. Move long-running turns to the existing async job lifecycle so mobile clients can disconnect and reconnect.
2. Add streaming events and reconnect support without tying job lifetime to the client connection.
3. Persist structured execution events and job/run references in the conversation.
4. Preserve approval checks, cancellation, usage budgets, run ownership, and secret filtering.
5. Add cross-platform CI and load tests against a durable store before enabling the feature in production.
