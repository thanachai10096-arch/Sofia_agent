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
- Markdown is an export / human-review format until a deployment explicitly wires a Markdown adapter into its memory lifecycle. The existing JSON stores remain the canonical runtime stores.

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

The existing user-memory API derives the owner from the authenticated API key. It supports scoped read/write operations, bounded retrieval, secret redaction, prompt-injection checks, and per-identity storage. This Markdown companion does not claim that the runtime automatically reads or writes `MEMORY.md` / `USER.md` yet.

## Templates

- [Project MEMORY.md](../templates/memory/MEMORY.md)
- [User USER.md](../templates/memory/USER.md)
