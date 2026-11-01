# Markdown Memory

Sofia has structured, file-backed memory stores already. Markdown files are a human-readable companion format, not a replacement for the existing stores or the authorization model.

## Files and ownership

| File | Scope | Purpose |
| --- | --- | --- |
| `MEMORY.md` | Project / workspace | Durable project conventions, verified decisions, and lessons |
| `USER.md` | One authenticated principal | Explicitly retained user preferences, goals, and instructions |
| Existing user-memory store | One authenticated principal | Structured entries, retrieval, and API lifecycle |
| Existing project-memory store | One project | Structured conventions, repair patterns, and workflow knowledge |
| Session transcript store | One authenticated session | Conversation history; not long-term memory |

Use the templates in `templates/memory/` when creating operator-managed Markdown files.

## Storage boundaries

- Never put real `USER.md` files in the source repository.
- Store each user's file under a private state directory using a stable, non-reversible principal-derived key. Do not use a client-supplied owner ID or raw email address as a path.
- Keep project memory separate from user memory. A workspace must not be able to read another tenant's user memory.
- Apply restrictive directory and file permissions, atomic writes, bounded file sizes, and safe path handling.
- Back up private state securely; do not commit runtime memory files.
- Runtime factories decorate the existing JSON stores with Markdown projections. JSON remains canonical; Markdown is a human-readable snapshot, not a second source of truth.
- Set `SOFIA_STATE_DIR` to an absolute persistent private directory in production. The project-memory helper otherwise uses the OS temporary directory by design.

## Read lifecycle

1. Resolve the authenticated principal and authorized workspace on the server.
2. Load only the matching user's memory and the current workspace's project memory.
3. Bound the amount of retrieved context by bytes / tokens.
4. Label retrieved Markdown as untrusted reference data.
5. Never allow memory content to change tool permissions, policy, identity, or approval requirements.
6. If memory is missing, corrupt, unavailable, or fails validation, continue without it and report diagnostics safely.

## Write lifecycle

1. Accept explicit user memory requests through an authenticated, scoped API or trusted UI action.
2. Treat automatically extracted facts as candidates, not saved facts. Ask for confirmation when intent is unclear.
3. Reject prompt-injection-like content and redact secrets before persistence.
4. Preserve provenance, timestamps, owner, scope, and confidence in structured metadata.
5. Prefer updating a matching entry over appending duplicates.
6. Use atomic writes and per-owner serialization. A multi-replica deployment requires a shared transactional store / lock.
7. Keep an audit trail for create, update, and delete operations without logging memory contents or secrets.

## Retrieval and conflict rules

- Explicit, newer user corrections supersede older preferences within the same scope.
- A project decision does not override a user's personal preference, and a user preference does not override project security policy.
- Conflicting or stale entries should be marked for confirmation rather than silently merged.
- Do not infer that an old fact is still true merely because it exists in memory.
- Treat all retrieved content as untrusted input. Tool calls must still pass through the normal policy gateway and approval checks.

## Existing implementation

The current user memory implementation is in `src/brain/user-memory.ts`; its API and security boundaries are described in [USER_MEMORY.md](./USER_MEMORY.md). Project memory is in `src/brain/project-memory.ts`. Agent-side user-memory retrieval is in `src/agent/core.ts`.

The existing user-memory API derives the owner from the authenticated API key. It supports scoped read/write operations, bounded retrieval, secret redaction, prompt-injection checks, and per-identity storage. The runtime automatically writes private Markdown projections after successful memory mutations. Retrieval continues to use the canonical structured stores.

## Templates

- [Project MEMORY.md](../templates/memory/MEMORY.md)
- [User USER.md](../templates/memory/USER.md)


## Non-destructive maintenance

`src/brain/memory-maintenance.ts` provides deterministic, offline analysis for memory hygiene:

- Exact duplicate groups are detected after Unicode, case, punctuation, and whitespace normalization.
- Similar entries of the same kind can be surfaced as review candidates.
- Analysis is bounded by record and candidate limits.
- The helper does not mutate stores, infer that two statements conflict, or decide which entry is authoritative.
- A caller must retain the original scope/provenance and obtain an explicit decision before merging, archiving, or deleting anything.

This is deliberately a review layer, not an autonomous consolidation job. It can be used by a future maintenance UI or scheduled diagnostic without risking silent memory loss.


## Hybrid retrieval

User and project memory keep their existing store interfaces and now share `rankMemoryDocuments` from `src/brain/memory-retrieval.ts`.

- Combines word-term coverage, character n-gram coverage, and exact phrase matching.
- Character n-grams support Thai and CJK queries without adding a tokenizer dependency.
- Results are relevance-ranked; recency breaks ties but cannot make an irrelevant item eligible.
- Candidate scanning and result counts are bounded; empty and low-relevance queries return no records.
- Retrieval is deterministic and local. This is lexical hybrid retrieval, not vector/embedding search; an embedding index can be added later behind the same retrieval boundary if evaluation justifies its cost.

The existing `UserMemoryStore.find` and `ProjectMemoryStore.find` contracts remain unchanged, so agent context injection and callers continue to use the same APIs.

## Conflict review

`detectMemoryConflicts` in `src/brain/memory-maintenance.ts` is a conservative candidate generator for entries that:
- belong to the same memory kind;
- share a high proportion of content terms after recognized negation markers are removed; and
- differ by an explicit English or Thai negation marker.

It reports the original entry IDs, scope kind, and lexical similarity. This is not general semantic contradiction detection: phrasing, double negatives, implicit opposites, temporal changes, and domain-specific meaning may be missed or misclassified. Treat every result as a prompt for human review. The helper never chooses an authoritative entry and never changes stored memory. Scans and result counts are bounded.

## Episodic memory (opt-in)

Episodic records reuse the existing project-memory store; they do not introduce another database or persistence engine. Use `ProjectEpisodicMemoryStore` with the existing `ProjectMemoryStore` implementation to record selected run outcomes and retrieve relevant episodes.

An episode contains a stable run ID, completed/failed outcome, short task and result summaries, optional timestamp, bounded evidence IDs, and bounded tags. Its deterministic ID is derived from the project and run ID, so retrying the same record updates the same entry instead of creating duplicates.

Recording is intentionally explicit. Integrators must decide which runs are appropriate to retain and should avoid storing raw prompts, full tool outputs, credentials, or private user content. The underlying project-memory store continues to apply its existing prompt-injection and secret-redaction protections. Episodes are project-scoped and appear in the generated `MEMORY.md` projection as untrusted reference data.

This first version does not automatically learn from every run, infer reusable procedures, or declare a failed strategy universally invalid. Retrieval returns matching episodes for later reasoning; callers remain responsible for relevance, privacy, and any promotion into verified project knowledge.

## Memory feedback and verified usefulness

`ProjectMemoryFeedbackStore` records explicit feedback about a memory after a run. Supported signals are `helpful`, `not_helpful`, `incorrect`, and `outdated`. Each feedback record is idempotent for a project + memory ID + source run ID tuple, and is persisted through the existing `ProjectMemoryStore`.

`summarize(project, memoryId)` derives counts and a bounded utility score from the feedback records. The score weights `incorrect` more strongly than ordinary negative feedback; it is only a review signal. It does not rewrite the original memory, change its confidence, delete it, or automatically suppress it. Callers should gather feedback only from trusted, explicit user or verifier actions and retain the project/memory scope.

This is a feedback ledger, not autonomous self-training. It does not infer that a memory is true merely because it was helpful once, and it does not promote a strategy without independent evidence and a verification step.

