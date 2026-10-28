# Model Provider Configuration

Sofia's model gateway uses an OpenAI-compatible chat-completions interface. This allows the same runtime to use many hosted and local model endpoints without tying the agent core to one vendor. Provider-specific protocols that are not OpenAI-compatible still need a dedicated adapter or a compatible gateway such as OpenRouter.

## Generic OpenAI-compatible endpoint

Use this for compatible hosted providers, OpenRouter-compatible endpoints, vLLM, Ollama's OpenAI-compatible API, and similar services:

```sh
SOFIA_MODEL_PROVIDER=openai-compatible
SOFIA_MODEL_BASE_URL=https://your-provider.example/v1
SOFIA_MODEL_API_KEY=your-model-provider-key
SOFIA_MODEL=vendor/model-name
```

The shorter aliases `BASE_URL`, `API_KEY`, and `MODEL` are supported for existing local setups when `BASE_URL` is present. Prefer the `SOFIA_MODEL_*` names for new deployments because they make the purpose explicit.

## Provider presets

OpenAI:

```sh
SOFIA_MODEL_PROVIDER=openai
OPENAI_API_KEY=your-openai-key
OPENAI_MODEL=gpt-4o-mini
```

OpenRouter:

```sh
SOFIA_MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=provider/model-name
```

Gemini remains supported for existing deployments:

```sh
SOFIA_MODEL_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key
GEMINI_MODEL=gemini-2.5-flash
```

If `SOFIA_MODEL_PROVIDER` is omitted, explicit custom `BASE_URL` configuration takes priority; otherwise the existing Gemini configuration is preserved when `GEMINI_API_KEY` is present, followed by OpenRouter and OpenAI credentials.

## Route-specific models

The runtime creates four capability routes: `fast`, `coding`, `reasoning`, and `vision`. Set a route-specific model when the provider offers suitable models:

- Generic endpoint: `SOFIA_FAST_MODEL`, `SOFIA_CODING_MODEL`, `SOFIA_REASONING_MODEL`, `SOFIA_VISION_MODEL`
- OpenAI: `OPENAI_FAST_MODEL`, `OPENAI_CODING_MODEL`, `OPENAI_REASONING_MODEL`, `OPENAI_VISION_MODEL`
- OpenRouter: `OPENROUTER_FAST_MODEL`, `OPENROUTER_CODING_MODEL`, `OPENROUTER_REASONING_MODEL`, `OPENROUTER_VISION_MODEL`
- Gemini: `GEMINI_FAST_MODEL`, `GEMINI_CODING_MODEL`, `GEMINI_REASONING_MODEL`, `GEMINI_VISION_MODEL`

A route model override is only a selection; it does not guarantee that a model supports vision, tool calling, JSON mode, or a given context length. Verify each model's capabilities with provider-specific integration tests.

## Security notes

- `SOFIA_API_KEY` authenticates clients to the Sofia API; it is **not** the model provider key.
- Keep model credentials in server-side environment variables or a secret manager. Do not put them in browser bundles, checked-in files, or logs.
- HTTPS is required for remote model endpoints. HTTP is accepted for loopback development endpoints; setting `SOFIA_MODEL_ALLOW_INSECURE_HTTP=true` explicitly opts into non-loopback HTTP and can expose credentials on the network.
- Do not configure a provider URL controlled by an untrusted user on a shared server. Sofia sends the configured model API key to that endpoint.
- OpenAI-compatible support is broad but not universal. Native Anthropic and other non-compatible protocols require a dedicated adapter or a compatible gateway; Sofia must not claim every model is supported until its protocol and capabilities have been tested.
