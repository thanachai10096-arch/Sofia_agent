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
- `POST /v1/conversations/:id/messages` — append a user message; JSON `{ "role": "user", "content": "..." }` (`agent:run`).
- `DELETE /v1/conversations/:id/messages` — clear message history (`agent:run`).
- `DELETE /v1/conversations/:id` — delete an owned session (`agent:run`).

If no conversation store is configured, these routes return `503 conversation_store_unavailable`. A message append currently persists the user message and returns bounded context; it does not yet call a model or launch an agent.

## Security and trust boundaries

- Derive ownership from authenticated credentials. Never trust an owner ID supplied by an untrusted client.
- Missing and non-owned sessions have the same not-found response.
- Clients cannot forge assistant or tool messages through the conversation API.
- Tool outputs are untrusted evidence, not system instructions.
- Do not store credentials, API keys, or secrets in conversation history.
- The file-backed store uses atomic file replacement and restrictive POSIX permissions where supported. It is intended for one process on a trusted local filesystem.
- For multi-process, serverless, or cloud deployment, implement a transactional database-backed `ConversationStore` and test access control, durability, concurrency, and deletion semantics.

## Next integration steps

1. Connect a user message to the existing Sofia Agent/Brain lifecycle.
2. Persist the assistant's final response and structured execution events in the same conversation.
3. Add streaming events and reconnect support without tying job lifetime to the client connection.
4. Preserve approval checks, cancellation, usage budgets, run ownership, and secret filtering.
5. Add integration tests against the configured API and a durable store before enabling the feature in production.
