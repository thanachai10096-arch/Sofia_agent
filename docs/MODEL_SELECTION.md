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

Select one provider for the server-side Sofia Core/API process:

| Provider | Selection | Required server-side key | Default API base |
|---|---|---|---|
| OpenRouter | `SOFIA_MODEL_PROVIDER=openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| Gemini | `SOFIA_MODEL_PROVIDER=gemini` | `GEMINI_API_KEY` | Google OpenAI-compatible endpoint |
| Anthropic | `SOFIA_MODEL_PROVIDER=anthropic` | `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` | `https://api.anthropic.com/v1` |
| DeepSeek | `SOFIA_MODEL_PROVIDER=deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |
| Custom OpenAI-compatible | `SOFIA_MODEL_PROVIDER=custom` | `SOFIA_BASE_URL`, `SOFIA_API_KEY`, `SOFIA_MODEL` | User-configured |

For DeepSeek, a minimal configuration is:

```dotenv
SOFIA_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-server-side-secret
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

`DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` may be omitted when the defaults are appropriate. Route-specific overrides follow the pattern `DEEPSEEK_FAST_MODEL`, `DEEPSEEK_CODING_MODEL`, `DEEPSEEK_REASONING_MODEL`, and `DEEPSEEK_VISION_MODEL`. Use model IDs currently enabled for your DeepSeek account. Do not assume every model supports every capability; confirm tool calling and structured-output support for the chosen model.

A custom OpenAI-compatible endpoint uses `SOFIA_BASE_URL`, `SOFIA_API_KEY`, and `SOFIA_MODEL`. The shorter `BASE_URL`, `API_KEY`, and `MODEL` aliases are also supported. Custom endpoints use the OpenAI Chat Completions-compatible protocol by default. Set `SOFIA_MODEL_PROTOCOL=anthropic-messages` only when the configured custom endpoint implements the Anthropic Messages API.

If multiple built-in provider credentials are present, set `SOFIA_MODEL_PROVIDER` explicitly. This avoids silently changing vendors when a second key is added. When no provider is explicitly selected, Sofia can auto-detect a single configured built-in provider.

Route-specific environment variables can assign different model IDs to fast, coding, reasoning, and vision routes. For built-in providers the variable prefix matches the provider, e.g. `DEEPSEEK_CODING_MODEL`.

Built-in OpenRouter, Gemini, and DeepSeek use the OpenAI-compatible Chat Completions protocol; Anthropic uses its native Messages request/response format. Other native protocols still need a dedicated adapter. Sofia does not claim every model API is protocol-identical.

## Messaging integrations

Telegram and Discord tasks are executed by the same Sofia Core/model gateway as API jobs. Configure the selected provider on the server process that owns the messaging integration; do not send provider credentials from Discord/Telegram clients. For DeepSeek + Discord setup and its live smoke-test procedure, see [Discord integration setup](DISCORD_INTEGRATION_SETUP.md).

Provider configuration in code is not proof of a live provider call. Before enabling production traffic, test a harmless prompt, tool calling if needed, error handling, and the messaging round trip in a private test environment. Never put provider keys in client apps, chat messages, source control, or logs.
