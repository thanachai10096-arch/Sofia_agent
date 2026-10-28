# Model provider configuration

Sofia keeps model selection separate from the agent runtime. Gemini remains the default for existing deployments, while the built-in OpenAI-compatible gateway can target several hosted providers, local servers, or compatible inference endpoints.

## Select a provider

Set these variables in the server process or your secret manager. Do not commit API keys.

| Provider | `SOFIA_MODEL_PROVIDER` | Required credentials | Default endpoint |
|---|---|---|---|
| Google Gemini | `gemini` (default) | `GEMINI_API_KEY` or legacy `Gemini_API_Key` | Google Gemini OpenAI-compatible endpoint |
| OpenAI | `openai` | `OPENAI_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.openai.com/v1` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://openrouter.ai/api/v1` |
| Ollama | `ollama` | Usually none for local use | `http://127.0.0.1:11434/v1` |
| Any OpenAI-compatible endpoint | `openai-compatible` | Depends on endpoint | Set `SOFIA_MODEL_BASE_URL` |

Common settings:

- `SOFIA_MODEL_NAME`: default model identifier for the selected endpoint.
- `SOFIA_MODEL_API_KEY`: provider-neutral API key override.
- `SOFIA_MODEL_BASE_URL`: endpoint override for a compatible server.
- `SOFIA_FAST_MODEL`, `SOFIA_CODING_MODEL`, `SOFIA_REASONING_MODEL`, `SOFIA_VISION_MODEL`: optional route-specific model IDs. If omitted, each route uses `SOFIA_MODEL_NAME`.
- Gemini deployments may continue using `GEMINI_MODEL`, `GEMINI_FAST_MODEL`, `GEMINI_CODING_MODEL`, `GEMINI_REASONING_MODEL`, and `GEMINI_VISION_MODEL`.

Example for a compatible endpoint:

```sh
SOFIA_MODEL_PROVIDER=openai-compatible
SOFIA_MODEL_BASE_URL=https://your-inference-host.example/v1
SOFIA_MODEL_API_KEY=your-secret
SOFIA_MODEL_NAME=provider/model-id
```

For a local Ollama server:

```sh
SOFIA_MODEL_PROVIDER=ollama
SOFIA_MODEL_NAME=your-installed-model
```

## Compatibility and security notes

- The built-in gateway currently uses the OpenAI Chat Completions-compatible request/response format. A model is usable through this path only if its provider endpoint implements the needed chat, tool-call, and usage fields.
- Providers with a different native protocol (for example, Anthropic's native Messages API) need a dedicated adapter or a compatible gateway; setting a provider name alone does not make every API protocol compatible.
- Unknown provider names fail closed. Sofia does not silently switch providers or send data to another service when a provider fails.
- Remote endpoints must use HTTPS. Plain HTTP is accepted only for loopback local model servers. URL credentials, query strings, and fragments are rejected.
- API keys are read from environment variables and are not written to Sofia's setup config by this module.
- Model capabilities differ. Configuring a model under a route name does not guarantee that the model actually supports vision, tool calls, structured output, or a given context length. Verify those features against the target endpoint before relying on them.
