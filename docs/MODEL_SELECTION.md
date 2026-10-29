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

