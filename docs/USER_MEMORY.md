# User-scoped memory

Sofia's user memory is opt-in by API action. It is not a policy store and never grants tools or permissions.

## Authentication and scopes

The API derives the memory owner from the authenticated API key. A client cannot choose another user's owner ID.

- `memory:read` permits listing and searching the authenticated user's memories.
- `memory:write` permits explicit memory creation, deleting one memory, and clearing all memories for that API identity.
- These scopes do not imply `agent:run`, desktop capabilities, or security-administrator access.

## API

- `GET /v1/memory` lists up to 200 stored memories.
- `GET /v1/memory?q=typescript&limit=8` searches memory content; query length is capped at 1,000 characters and result count at 20.
- `POST /v1/memory` accepts `{ "kind": "preference", "content": "Prefers concise answers" }`. Kinds: `preference`, `fact`, `goal`, `instruction`.
- `DELETE /v1/memory/:id` deletes one entry.
- `DELETE /v1/memory` clears all memories for the authenticated identity.

Memory writes reject prompt-injection-like content, redact common API/token secrets, cap content at 1,200 characters and retain at most 200 entries per identity. The file store hashes the owner identity before using it in a filename and uses private local filesystem permissions. A memory's source is recorded as an explicit user request; callers should not store inferred profile facts without user intent.

## Limits

This is local-first, file-backed storage. Writes are serialized within one process but do not provide a distributed transaction across multiple hosts sharing a volume. For multi-host deployment, use a shared transactional store before relying on concurrent writes across replicas.

Memory entries are untrusted reference context, not instructions. When `AgentDependencies.userMemoryStore` is configured and an authenticated `principalId` is present, Sofia searches for up to six entries relevant to the current task and includes a bounded, clearly labeled section in model context. Retrieval is best-effort: store errors do not block the task. Requests without an authenticated principal, tasks with no matching memories, or deployments without a memory store do not receive user-memory context. Retrieved memories never grant tool permissions; normal authorization and policy checks still apply to every action.
