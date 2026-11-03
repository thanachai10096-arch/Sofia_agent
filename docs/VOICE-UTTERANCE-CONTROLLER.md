# Voice utterance controller

`createVoiceUtteranceController` composes the existing provider-neutral VAD state machine, bounded in-memory pre-roll buffer, and `VoiceSession`.

## Host contract

- The host decodes/captures audio frames and supplies exactly one configured frame duration per call.
- The host VAD supplies a speech probability in the range 0..1 for each frame.
- The controller copies frames, retains only bounded pre-roll before speech, and assembles one complete utterance when VAD ends.
- The completed utterance is passed to the existing `VoiceSession.processTurn`; STT still receives a complete audio input.
- `onSpeechStart` is the host hook to stop local playback or cancel a TTS player. The controller also requests interruption of an active session turn.
- `onTurnResult` receives the normal VoiceWorkflow result. `onError` receives processing or observer errors.

## Safety and limits

- Audio remains in memory; pre-roll and capture buffers are cleared when the controller closes.
- The utterance byte limit is enforced before retaining additional frames.
- Frame duration must match the VAD configuration so the host cannot silently misstate timing.
- The host remains responsible for decoding, real media duration verification, microphone permissions, transport buffering, and cancellation of platform playback.
- This is not streaming STT/TTS, WebRTC, echo cancellation, or a production microphone integration. VoiceWorkflow still processes complete turns.

## Lifecycle

Create one controller per voice session. Call `close()` on session teardown, permission revocation, or privacy-boundary changes. Do not reuse a closed controller.
