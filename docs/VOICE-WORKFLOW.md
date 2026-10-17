# Optional voice workflow

VoiceWorkflow is an optional, provider-agnostic speech pipeline. The host supplies speech-to-text and optionally text-to-speech providers. Transcribed text is passed to a host callback that should call Sofia through its normal runtime and policy path.

## Privacy and safety

- No provider is bundled and no audio is sent anywhere unless the host configures a provider.
- Audio is processed in memory and is not persisted by this class.
- Input MIME type, byte size, duration metadata, transcript length, provider output, and stage timeouts are validated.
- The duration limit trusts the host-supplied duration metadata; a production adapter should independently inspect media duration and decode safely.
- Keep provider credentials outside source control. Explain provider retention and processing terms to users before enabling external services.
- This is a voice workflow foundation, not a built-in STT/TTS provider or a messaging-platform voice adapter.
