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
- When a new entry conflicts with an existing same-kind memory, `POST /v1/memory` returns `409 memory_conflict_review_required` with advisory candidates and the available decisions.
- `POST /v1/memory/review` accepts the candidate `kind`, `content`, and an explicit `decision`: `keep-existing` leaves the current memory untouched; `keep-both` saves the new entry while retaining all older entries. Both require `memory:write` and a conflict is rechecked at review time.


Memory writes reject prompt-injection-like content, redact common API/token secrets, cap content at 1,200 characters and retain at most 200 entries per identity. The file store hashes the owner identity before using it in a filename and uses private local filesystem permissions. A memory's source is recorded as an explicit user request; callers should not store inferred profile facts without user intent.

## Lifecycle and conflict review

Repeated saves with equivalent normalized content in the same user scope and memory kind update the existing entry rather than creating duplicates. The existing ID, creation timestamp, and usage count are retained; the update timestamp is refreshed and confidence does not decrease.

The file store also exposes an optional `findPotentialConflicts` capability. It conservatively flags same-kind entries with substantial shared wording but opposite English or Thai negation. This is an advisory heuristic, not semantic understanding: callers should present candidates for review rather than treating them as proven contradictions. Saving a changed statement does not delete or silently overwrite the older entry. Conflict review is scoped to the authenticated user's memory.

## Limits

This is local-first, file-backed storage. Writes are serialized within one process but do not provide a distributed transaction across multiple hosts sharing a volume. For multi-host deployment, use a shared transactional store before relying on concurrent writes across replicas.

Memory entries are untrusted context, not instructions. For an authenticated agent request, Sofia performs best-effort retrieval of up to four relevant entries and caps injected memory context at 2,400 characters. Retrieved content is fenced as untrusted reference data and cannot grant tools or permissions. A memory-store failure does not block the task. Current authorization is re-checked for every action.

Search relevance uses a minimum 50% query-term coverage for ordinary multi-term matches. Exact phrase and memory-kind queries remain eligible. This prevents a single incidental shared word from injecting an otherwise unrelated memory; it is a lexical filter, not semantic relevance ranking.
