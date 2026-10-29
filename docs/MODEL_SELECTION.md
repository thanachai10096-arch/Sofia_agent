# Model provider and route selection

Sofia uses one agent runtime with a configurable model gateway. Provider endpoints and credentials are operator-configured on the server. Authenticated clients can choose a configured route or ask Sofia to select automatically; clients never send provider API keys or arbitrary base URLs.

## List available routes

Authenticated clients can call:

```http
GET /v1/models
Authorization: Bearer <SOFIA_API_KEY>
```

The response includes each configured route's ID, model identifier, capabilities, and health state. It never returns provider API keys.

## Choose a route for a run

Send a route ID returned by `GET /v1/models`:

```json
{
  "task": "Review this TypeScript module",
  "modelRouteId": "coding"
}
```

Use `modelRouteId: "auto"` or omit the field to let Sofia choose based on task capabilities and configured cost/latency/quality weights. The same option is accepted for streaming runs and durable jobs. Durable jobs persist the selected route so resumed work keeps the same selection.

An explicitly selected route is not silently replaced by another route. If the route is unknown or unhealthy, Sofia returns a visible error. Use automatic selection when a task may require different capabilities.

## Configure a shared provider

For a single provider shared by all routes, configure one of:

- `SOFIA_MODEL_PROVIDER=openrouter` with `OPENROUTER_API_KEY`.
- `SOFIA_MODEL_PROVIDER=gemini` with `GEMINI_API_KEY`.
- `SOFIA_MODEL_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`.
- `SOFIA_MODEL_PROVIDER=custom` with `SOFIA_BASE_URL`, `SOFIA_API_KEY`, and `SOFIA_MODEL`.

Route-specific model IDs can be set with the existing provider-prefixed variables, such as `GEMINI_CODING_MODEL` or `OPENROUTER_REASONING_MODEL`.

## Configure a different provider for each route

Each of the four routes (`fast`, `coding`, `reasoning`, `vision`) may use an independent OpenAI Chat Completions-compatible endpoint, API key, and model ID:

| Route | Base URL | API key | Model ID |
| --- | --- | --- | --- |
| fast | `SOFIA_ROUTE_FAST_BASE_URL` | `SOFIA_ROUTE_FAST_API_KEY` | `SOFIA_ROUTE_FAST_MODEL` |
| coding | `SOFIA_ROUTE_CODING_BASE_URL` | `SOFIA_ROUTE_CODING_API_KEY` | `SOFIA_ROUTE_CODING_MODEL` |
| reasoning | `SOFIA_ROUTE_REASONING_BASE_URL` | `SOFIA_ROUTE_REASONING_API_KEY` | `SOFIA_ROUTE_REASONING_MODEL` |
| vision | `SOFIA_ROUTE_VISION_BASE_URL` | `SOFIA_ROUTE_VISION_API_KEY` | `SOFIA_ROUTE_VISION_MODEL` |

Set all three values for a route together. Partial configuration fails closed instead of silently using a different provider. Routes without overrides use the shared provider configuration. If all four routes have complete overrides, the shared provider is not required.

Example (server-side environment only):

```bash
SOFIA_ROUTE_FAST_BASE_URL=https://api.openai.com/v1
SOFIA_ROUTE_FAST_API_KEY=<server-secret>
SOFIA_ROUTE_FAST_MODEL=<model-id>

SOFIA_ROUTE_CODING_BASE_URL=https://openrouter.ai/api/v1
SOFIA_ROUTE_CODING_API_KEY=<server-secret>
SOFIA_ROUTE_CODING_MODEL=<provider/model-id>
```

Do not put these API keys in browser JavaScript, mobile app bundles, public repositories, or client-side configuration. Configure secrets in your deployment's server-side secret store.

## Protocol compatibility

The route-specific variables above use the OpenAI Chat Completions-compatible protocol. A provider that exposes a different native protocol needs a dedicated adapter; a model name alone does not make incompatible APIs interchangeable. Sofia does not claim to support every model API automatically. Check the provider's API compatibility, tool-call behavior, structured-output support, and vision format before selecting a model for a route.
