# Optional voice workflow and channel contract

`VoiceWorkflow` is an optional, provider-agnostic speech pipeline. The host supplies speech-to-text (STT) and optionally text-to-speech (TTS) providers. Transcribed text is passed to a host callback that should call Sofia through its normal runtime and policy path.

`createVoiceProviderRegistry` provides explicit STT/TTS provider registration and selection independently of the LLM route. `loadVoiceProviderSelectionFromEnv` reads only `SOFIA_VOICE_ENABLED`, `SOFIA_VOICE_STT_PROVIDER`, and optional `SOFIA_VOICE_TTS_PROVIDER`; voice is disabled by default and this helper never reads or returns credentials.

`createOpenAICompatibleVoiceProviders` adds an opt-in adapter for compatible `/audio/transcriptions` and `/audio/speech` endpoints. It uses injected/global `fetch` and no new package dependency. It requires a non-empty server-side API key and an explicit HTTPS base URL (HTTP is permitted only for loopback development), rejects URL credentials/query/fragments, uses request cancellation, bounds provider response bytes, validates response shapes/content type, and avoids returning provider response bodies in errors. The adapter is not auto-registered and does not prove compatibility with every provider; check the target provider's API and data-handling terms before enabling it. No live provider has been tested by unit tests.

`createVoiceChannelHandler` is the shared channel-neutral adapter layer. It accepts an already-verified `VerifiedVoiceEvent`, checks a host-supplied access policy, claims a stable event key through a deduplicator, runs the existing `VoiceWorkflow`, and delivers text/audio through a host-supplied delivery adapter. It deliberately does not implement provider webhook verification, remote media fetching, browser microphone capture, or a platform transport.

## Integrating a channel

1. Verify the platform webhook/signature/secret and derive immutable sender, conversation, and event IDs from trusted platform metadata.
2. Enforce platform payload limits before buffering or downloading media.
3. For remote media URLs, use an SSRF-safe downloader with strict host/redirect/DNS checks, byte limits, and timeouts; do not pass arbitrary URLs to the handler.
4. Decode/inspect media safely and derive actual duration rather than trusting unverified duration metadata.
5. Pass a normalized event to `createVoiceChannelHandler` with the existing Sofia workflow, channel access policy, durable deduplicator, and platform-specific delivery implementation.
6. Route the transcript through the normal Sofia runtime and policy path. Never add a voice-only tool execution bypass.
7. Run adapter-specific tests and a live sandbox smoke test before describing the channel as supported.

## Supported contract surface

The shared type covers API, SDK, CLI, Web, Desktop, Mobile, Telegram, Discord text, Discord voice, Slack, WhatsApp, Signal, and Matrix. This is a normalized event contract, **not a claim that transport adapters or provider integrations for all of these channels already exist**.

The handler uses an at-most-once event-claim default: it does not release a claim after ambiguous downstream failures because the agent may already have performed an action. Retry-capable adapters should use a durable run/idempotency contract to avoid duplicate actions.

## Privacy and safety

- The registry and provider interfaces are implemented, but no concrete STT/TTS provider is bundled; no audio is sent anywhere unless a host registers and explicitly selects a provider.
- Audio is processed in memory and is not persisted by this class.
- Input MIME type, byte size, duration metadata, transcript length, provider output, and stage timeouts are validated by the workflow.
- The workflow's duration limit trusts host-supplied duration metadata; a production adapter must independently inspect media duration and decode safely.
- Keep provider credentials outside source control. Explain provider retention and processing terms to users before enabling external services.
- Do not log raw audio, transcripts, provider payloads, API keys, or platform tokens.
- Generated audio is output-only; do not feed it back into the same session as a fresh user turn.
- Feature access, approval gates, tool permissions, session ownership, and audit behavior remain governed by the ordinary Sofia runtime.


## OpenAI-compatible provider adapter

The adapter is a building block for providers that implement the expected OpenAI-style audio endpoints. Register it explicitly on the server; do not expose the API key to a browser, mobile app, or chat platform.

```ts
import {
  createOpenAICompatibleVoiceProviders,
  loadOpenAICompatibleVoiceConfigFromEnv,
  createVoiceProviderRegistry,
} from "sofia-agent";

const config = loadOpenAICompatibleVoiceConfigFromEnv();
if (!config) throw new Error("Voice provider is not configured");

const providers = createOpenAICompatibleVoiceProviders(config);

const registry = createVoiceProviderRegistry();
registry.registerStt("configured-stt", providers.stt);
if (providers.tts) registry.registerTts("configured-tts", providers.tts);
```

The environment loader expects `SOFIA_VOICE_BASE_URL`, `SOFIA_VOICE_API_KEY`, and `SOFIA_VOICE_STT_MODEL` together. Optional settings are `SOFIA_VOICE_TTS_MODEL`, `SOFIA_VOICE_TTS_VOICE`, and `SOFIA_VOICE_MAX_RESPONSE_BYTES`. It returns `undefined` when no provider settings are present and throws on partial configuration. The example illustrates server-side composition only; voice must still be explicitly enabled and provider IDs selected in the registry. Do not assume that a provider accepts the same audio formats, endpoint paths, or response semantics merely because it offers an OpenAI-compatible chat API. This adapter currently has automated mock tests, not a live-provider certification.
