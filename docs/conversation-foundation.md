# Sofia Conversation Foundation

This module is a provider-independent foundation for natural-language conversations. It is intentionally separate from the Agent runtime while the API contract and integration tests are developed.

## Included

- Owner-scoped conversation sessions and message history.
- User, assistant, and tool-result message types.
- Bounded message length, history length, list size, and model-context size.
- Context assembly that preserves the newest contiguous messages in chronological order.
- Session clear and delete operations.
- A volatile in-memory store suitable for tests and prototypes.

## Security and trust boundaries

- The caller must derive `ownerId` from an authenticated principal. Never trust an owner ID supplied by an untrusted client.
- The service returns the same “not found” behavior for missing and non-owned sessions.
- Tool outputs are represented as `tool` messages and must be treated as untrusted evidence, not as system instructions.
- Do not store credentials, API keys, or secrets in conversation history.
- This implementation is not durable across process restarts. A production integration must supply a durable, access-controlled `ConversationStore` and test its failure and deletion semantics.

## Not yet integrated

This module does not call a model, stream tokens, execute tools, or change the public API. The next step is to connect it to an authenticated conversation endpoint and Sofia's existing Agent/Brain lifecycle without creating a second planner or tool gateway. Integration must preserve approval checks, cancellation, usage budgets, and run ownership.
