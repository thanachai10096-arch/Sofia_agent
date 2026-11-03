# Voice playback lifecycle

Sofia's voice pipeline deliberately leaves microphone capture and device playback to channel hosts. This contract gives those hosts one shared cancellation/replacement lifecycle without introducing a platform-specific audio dependency.

## Adapter contract

Implement `VoicePlaybackAdapter` with:

- `play(audio, signal)`: play the supplied audio and honor abort promptly.
- `stop()`: stop all audible output and resolve only after playback is silent.

Create one `VoicePlaybackController` per host voice session. Route generated `VoiceTurnResult.audioReply` through `play()`. Connect barge-in to `interrupt()`; for example, the host's `onSpeechStart` callback should request interruption and handle its promise. Call `close()` when the session ends or microphone permission is revoked.

## Guarantees and limits

- New playback supersedes older playback; the old signal is aborted and host `stop()` completes before the new audio starts.
- Interruption invalidates pending starts as well as active playback, preventing stale replies from becoming audible after a newer user utterance.
- Audio bytes are defensively copied before handing them to the adapter.
- This module does not capture microphones, decode media, implement echo cancellation, or provide a concrete OS/browser audio player. The adapter must honor cancellation and stop semantics; physical-device verification remains a host integration test.
