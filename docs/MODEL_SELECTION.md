# Model provider and route selection

Sofia uses the same agent runtime with a configurable model gateway. Provider credentials remain server-side; clients choose only among configured route IDs.

## List available routes

Authenticated clients can call:

```http
GET /v1/models
Authorization: Bearer <SOFIA_API_KEY>
```

The response includes each configured route's id, model identifier, capabilities, and health state. It never returns provider API keys.

## Choose a route for a run

Send the route ID returned by /v1/models:

```json
{
  "task": "Review this TypeScript module",
  "modelRouteId": "coding"
}
```

Use modelRouteId set to "auto" or omit the field to let Sofia choose a route based on task capabilities and the configured cost/latency/quality weights. The same option is accepted for streaming runs and durable jobs. Durable jobs persist the selected route so resumed work keeps the same selection.

An explicitly selected route is not silently replaced by another route. If the route is unknown, unhealthy, or cannot satisfy the task's declared capabilities, Sofia returns a visible error. Use automatic selection when the task may require different capabilities.

For Brain inference in automatic mode, Sofia may try another eligible route after a provider failure only when the failed provider reports validated token usage. That usage is charged before the next route is attempted. If usage is unknown, the run budget is stopped and no fallback request is sent; cancellation, timeout, invalid output, and output-cap violations are also not retried. Each provider attempt is limited to one request.

## Provider configuration

- SOFIA_MODEL_PROVIDER=openrouter selects OpenRouter.
- SOFIA_MODEL_PROVIDER=gemini selects Gemini.
- SOFIA_MODEL_PROVIDER=custom uses SOFIA_BASE_URL, SOFIA_API_KEY, and SOFIA_MODEL for an OpenAI Chat Completions-compatible endpoint.
- When no provider is explicitly selected, configure only one built-in provider credential. If both OpenRouter and Gemini credentials exist, Sofia requires explicit selection rather than silently redirecting requests.
- Route-specific environment variables can assign different model IDs to fast, coding, reasoning, and vision routes.

Custom endpoints use the OpenAI Chat Completions-compatible protocol by default. Set `SOFIA_MODEL_PROTOCOL=anthropic-messages` only when the configured custom endpoint implements the Anthropic Messages API. Built-in OpenRouter and Gemini use OpenAI-compatible requests; Anthropic uses its native Messages request/response format. Other native protocols still need a dedicated adapter; Sofia does not claim every model API is protocol-identical.


### Declaring route capabilities

Capability metadata is optional and must be declared by the operator; Sofia does not infer it from a model name. For example:

```dotenv
SOFIA_CODING_SUPPORTS_TOOL_CALLING=true
SOFIA_CODING_SUPPORTS_VISION=false
SOFIA_CODING_SUPPORTS_STRUCTURED_OUTPUT=true
SOFIA_CODING_CONTEXT_WINDOW=128000
```

The route prefixes are `SOFIA_FAST`, `SOFIA_CODING`, `SOFIA_REASONING`, and `SOFIA_VISION`. Boolean values accept `true/false`, `1/0`, or `yes/no`. Invalid values fail configuration loading rather than being silently ignored. Context window values must be positive safe integers. Unset fields remain unknown. These declarations guide routing; they are not live provider-verified guarantees.

### Brain token limits

The Brain route adapter also supports per-route runtime overrides:

```dotenv
SOFIA_CODING_CONTEXT=64000
SOFIA_CODING_MAX_OUTPUT=4096
```

The `_CONTEXT` override takes precedence over the declared `_CONTEXT_WINDOW` metadata for that route. Both runtime overrides must be positive safe integers; malformed, fractional, zero, or negative values fail route initialization with the variable name in the error. If unset, Sofia uses the declared context window when available (otherwise 32000) and a default maximum output of 4096 tokens. The gateway still applies its own phase-specific input/output caps and budget controls.
### Per-route token pricing and budget isolation

Brain token accounting uses each configured route ID as its model-budget key. This keeps route-specific pricing independent even when multiple routes share one provider. Configure prices in nano-USD per token:

```dotenv
SOFIA_CODING_INPUT_NANO_USD=...
SOFIA_CODING_OUTPUT_NANO_USD=...
```

The same `SOFIA_<ROUTE_ID>_INPUT_NANO_USD` and `SOFIA_<ROUTE_ID>_OUTPUT_NANO_USD` pattern applies to other route IDs. The run-wide limits (for example `SOFIA_BRAIN_MAX_TOKENS` and `SOFIA_BRAIN_MAX_MODEL_CALLS`) remain shared across all routes in that run; `SOFIA_BRAIN_MODEL_MAX_TOKENS` is applied independently to each route's model budget.


### Durable Brain token budget checkpoints

Brain run snapshots now optionally include a versioned token-budget ledger. The ledger stores settled aggregate and per-route token counts, call counts, committed nano-USD cost, the unmetered-call count, and the stopped state. Resume restores those values before the next model call; restored values are checked against the currently configured run/model limits and the exact configured route-key set. Older snapshots without a ledger continue to resume with a fresh ledger for backward compatibility.

The ledger is captured at Brain checkpoint boundaries. A privacy-minimal durable settlement journal now records an opaque attempt ID and token reservation before each provider call, then records validated usage when available. The journal contains no prompts, task text, provider responses, credentials, or raw route/provider/model names. Journal entries are stored under hashed workspace/run paths with restrictive directory/file permissions. After a Brain/job snapshot is durably saved, the journal records a checkpoint acknowledgement. On process restart, any attempt started after the last acknowledged checkpoint blocks automatic model execution, even if a settlement record exists; this avoids silently replaying a potentially billable request when the corresponding budget snapshot may be stale. Corrupt journal data also fails closed. In-flight reservations are not restored as committed usage.


### Budget checkpoint privacy

The persisted budget ledger contains aggregate token counts, call counts, committed cost, safety-stop state, and one-way SHA-256 fingerprints of configured route keys. It does not store prompts, task text, provider responses, API keys, authorization headers, or raw provider/model route names. Legacy version-one snapshots with plain route keys remain readable for backward compatibility; newly written snapshots use version two fingerprints. These fingerprints are pseudonymous metadata, not encryption or a guarantee of anonymity. The settlement journal also uses opaque attempt IDs and hashed run filenames; it is local accounting metadata, not a provider-side billing reconciliation system. Exactly-once billing cannot be guaranteed when a provider does not expose idempotency or usage-reconciliation APIs. An unresolved attempt requires operator review; Sofia deliberately does not retry it automatically.

### Privacy retention and deletion

Durable job history has a configurable retention window. `SOFIA_JOB_RETENTION_DAYS` defaults to 30 days and accepts values from 1 to 3650; expired `completed`, `failed`, and `cancelled` jobs are pruned opportunistically when the durable job runtime lists jobs. Queued and running jobs are not eligible. Pruning also deletes the linked run snapshot and settlement journal file when a run ID is available. Set a retention period appropriate to the deployment's legal and operational requirements; this is a local file-store lifecycle, not a guarantee of erasure from backups, filesystem snapshots, logs, or external providers.

Job metadata remains in the workspace-scoped durable job index and is filtered by the authenticated API-key owner. Dedicated run snapshots are additionally stored in an owner-specific namespace derived from the authenticated principal (never from a caller-supplied workspace or session ID); local single-user mode retains its previous namespace. The runtime resolves the owner before loading, saving, or deleting a dedicated snapshot, while the embedded redacted job snapshot remains a recovery fallback. Historical job records with embedded snapshots remain recoverable; a legacy record that depended only on the old shared snapshot file may not be recoverable after namespace isolation and must fail closed rather than replay without a checkpoint.

The settlement journal intentionally remains in its existing workspace namespace for now. Earlier journal events contain no owner metadata, so moving them into per-owner directories would hide unresolved billing evidence and could permit duplicate inference after restart. The journal stores only opaque run/attempt identifiers, timestamps, reservation bounds, and validated token usage—not prompts, task text, responses, credentials, or model names. Run IDs are generated internally. Per-user journal partitioning requires a versioned ownership migration that preserves all legacy unresolved events; it is not claimed here.

Retention prunes terminal jobs and deletes the dedicated run snapshot using the job's persisted owner scope. Journal evidence is deleted only through the existing fail-closed journal checks; unresolved or malformed evidence remains. This local lifecycle does not guarantee erasure from backups, filesystem snapshots, logs, or external providers. Per-user deletion and backup erasure still require deployment-level identity and backup lifecycle integration.
