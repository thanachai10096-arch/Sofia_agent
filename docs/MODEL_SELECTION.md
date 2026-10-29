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
