# Model provider configuration

Sofia keeps model selection separate from the agent runtime. Gemini remains the default for existing deployments, while the built-in OpenAI-compatible gateway can target several hosted providers, local servers, or compatible inference endpoints.

## Select a provider

Set these variables in the server process or your secret manager. Do not commit API keys.

| Provider | `SOFIA_MODEL_PROVIDER` | Required credentials | Default endpoint |
|---|---|---|---|
| Google Gemini | `gemini` (default) | `GEMINI_API_KEY` or legacy `Gemini_API_Key` | Google Gemini OpenAI-compatible endpoint |
| OpenAI | `openai` | `OPENAI_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.openai.com/v1` |
| Anthropic Claude | `anthropic` | `ANTHROPIC_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.anthropic.com/v1` (native Messages API) |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://openrouter.ai/api/v1` |
| xAI | `xai` | `XAI_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.x.ai/v1` |
| Mistral | `mistral` | `MISTRAL_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.mistral.ai/v1` |
| Groq | `groq` | `GROQ_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.groq.com/openai/v1` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.deepseek.com/v1` |
| Together AI | `together` | `TOGETHER_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.together.xyz/v1` |
| Fireworks AI | `fireworks` | `FIREWORKS_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.fireworks.ai/inference/v1` |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.cerebras.ai/v1` |
| Perplexity | `perplexity` | `PERPLEXITY_API_KEY` or `SOFIA_MODEL_API_KEY` | `https://api.perplexity.ai` |
| Ollama | `ollama` | Usually none for local use | `http://127.0.0.1:11434/v1` |
| Any OpenAI-compatible endpoint | `openai-compatible` | Depends on endpoint | Set `SOFIA_MODEL_BASE_URL` |

Common settings:

- `SOFIA_MODEL_NAME`: model identifier for the selected endpoint. It is required for providers whose available model IDs change frequently.
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

## Discover available models

The public `discoverModels` helper can query an endpoint's `/models` route using the configured protocol and authentication. It returns model IDs and provider metadata when available.

```ts
import { discoverModels } from "sofia-agent";

const models = await discoverModels({
  baseUrl: process.env.SOFIA_MODEL_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.SOFIA_MODEL_API_KEY ?? process.env.OPENAI_API_KEY,
});
console.log(models.map(({ id, displayName }) => ({ id, displayName })));
```

Discovery does not send a generation request and does not prove a model supports tools, vision, structured output, or a specific context window. Capability metadata is reported as unknown until a provider exposes reliable metadata or a separate compatibility test verifies it. Requests use a timeout, refuse redirects, require HTTPS for remote hosts, and never include API keys in URLs.

### Verify a model's real capabilities

Model discovery lists IDs; it does not prove the model can generate responses or call tools. For an explicit, opt-in smoke test, use \`probeModelCapabilities\`:

\`\`\`ts
import { probeModelCapabilities } from "sofia-agent";

const result = await probeModelCapabilities({
  baseUrl: process.env.SOFIA_MODEL_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.SOFIA_MODEL_API_KEY ?? process.env.OPENAI_API_KEY,
  model: process.env.SOFIA_MODEL_NAME ?? "your-model-id",
  // Set protocol: "anthropic" for the native Anthropic Messages API.
});
console.log(result);
\`\`\`

This sends a small ordinary chat request and a second request that asks for a named tool call. It never executes the returned tool. These requests may incur provider charges and may be logged by that provider, so call this helper only when the operator explicitly wants to test a configured endpoint. A model is marked as supporting tool use only when a tool-call response is actually observed; rejected or ambiguous tool requests remain \`unknown\`. The probe does not certify vision, reasoning quality, structured output, or context-window size.

## Compatibility and security notes

- The gateway supports the OpenAI Chat Completions-compatible protocol and a native Anthropic Messages API path. Other native protocols need their own adapter or a compatible gateway.
- The Anthropic path translates chat messages, tool definitions/tool calls, and token usage into Sofia’s common model interface. Structured Brain output is requested through instructions; availability and behavior still depend on the selected Claude model.
- Unknown provider names fail closed. Sofia does not silently switch providers or send data to another service when a provider fails.
- Remote endpoints must use HTTPS. Plain HTTP is accepted only for loopback local model servers. URL credentials, query strings, and fragments are rejected.
- API keys are read from environment variables and are not written to Sofia's setup config by this module.
- Model capabilities differ. Configuring a model under a route name does not guarantee that the model actually supports vision, tool calls, structured output, or a given context length. Verify those features against the target endpoint before relying on them.
