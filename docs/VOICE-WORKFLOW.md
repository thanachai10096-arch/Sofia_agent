# Optional voice workflow and channel contract

`VoiceWorkflow` is an optional, provider-agnostic speech pipeline. The host supplies speech-to-text (STT) and optionally text-to-speech (TTS) providers. Transcribed text is passed to a host callback that should call Sofia through its normal runtime and policy path.

`createVoiceProviderRegistry` provides explicit STT/TTS provider registration and selection independently of the LLM route. `loadVoiceProviderSelectionFromEnv` reads only `SOFIA_VOICE_ENABLED`, `SOFIA_VOICE_STT_PROVIDER`, and optional `SOFIA_VOICE_TTS_PROVIDER`; voice is disabled by default and this helper never reads or returns credentials. It does not implement concrete providers.

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
