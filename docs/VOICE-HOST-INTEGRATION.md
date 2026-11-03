# Voice host integration contract

Status: architecture and acceptance criteria only. This document does not claim that
Sofia currently captures microphone audio or plays audio on a desktop or web device.

## Current verified boundary

The shared voice layer owns provider-independent orchestration:

- `VoiceWorkflow` accepts complete audio input, transcribes it, calls the host-supplied
  agent runner, and optionally synthesizes a reply.
- `VoiceSession` serializes turns and supports interruption and closure.
- `VoiceUtteranceController` accepts host-produced audio frames and VAD probabilities,
  bounds pre-roll/utterance memory, and submits completed turns.
- `VoicePlaybackController` serializes host playback, cancellation, replacement, and
  stale-result suppression.
- Telegram voice is a separate complete-file integration. It must not be routed through
  a desktop/web microphone capture path.

The existing desktop runtime and `DesktopHostDriver` cover screen/input/application
operations. They do not currently define microphone capture or audio playback.
The repository's `src/browser/runtime.ts` is a Playwright/browser-automation runtime,
not a user-facing browser application or browser microphone host. No existing
`getUserMedia`, `MediaRecorder`, or `AudioContext` host implementation was found
in the inspected branch.

## Required host boundary

A future host adapter must implement the existing controller inputs/outputs rather
than duplicating transcription, session, VAD policy, or agent execution:

1. Request microphone permission only after an explicit user action.
2. Capture frames in the host and attach measured frame duration and MIME/codec metadata.
3. Supply speech probabilities from a documented VAD implementation; do not treat
   arbitrary host metadata as proof that audio is valid.
4. Feed frames to `VoiceUtteranceController` with strict byte, duration, and queue limits.
5. Route synthesized audio through `VoicePlaybackController`; the adapter's `play`
   promise must settle on completion or abort.
6. On stop, permission revocation, device removal, page hide, host shutdown, or logout:
   abort capture, stop tracks/devices, interrupt playback, close the utterance controller,
   and release every stream, worklet, callback, object URL, and temporary buffer.
7. Keep raw audio in memory only unless the user explicitly enables a separately
   designed recording feature. Never log audio bytes, transcripts by default, tokens,
   or provider credentials.

## Browser adapter requirements

- Use `navigator.mediaDevices.getUserMedia` only from a user-initiated action and
  handle unavailable APIs, denied permissions, device changes, and insecure origins.
- Prefer an AudioWorklet-based frame pipeline where supported; do not block the UI
  thread. If a MediaRecorder fallback is used, document that its chunk timing/codec
  behavior differs from fixed-duration PCM frames and do not feed those chunks into
  the frame controller as if they were equivalent.
- Playback must use a bounded Blob/object-URL or Web Audio path, revoke object URLs,
  release AudioContext resources, and honor AbortSignal promptly.
- Browser permission state is advisory; the adapter must still handle runtime
  permission revocation and track `ended` events.
- Do not request camera, screen, or unrelated permissions for voice.

## Desktop adapter requirements

- The desktop host must own native microphone/device access; the shared runtime must
  not shell out to arbitrary model-provided commands or accept arbitrary executable
  paths for audio capture.
- Select a supported, maintained native audio dependency only after validating its
  platform coverage, license, install footprint, signed/native binary distribution,
  and CI feasibility on Windows, macOS, and Linux.
- Expose explicit device selection and a visible recording indicator. Never start
  capture on application launch or silently resume after a device/permission error.
- Device loss and host shutdown must abort the active session and release native
  handles deterministically.

## Security and lifecycle invariants

- Microphone access is a distinct capability from screen capture and desktop input.
  It must not be implied by existing desktop capabilities.
- Permission denial is fail-closed. No silent fallback to another input device.
- Audio buffers are bounded and copied at trust boundaries. Enforce maximum frame
  size, total utterance size, duration, and queue depth.
- Abort must stop the physical capture/playback resource, not merely mark a controller
  state as idle.
- A stale turn must never start playback after a newer turn, interrupt, or close.
- User-visible mute/stop must synchronously disable further frame delivery before
  asynchronous cleanup begins.
- Never persist microphone audio, provider request bodies, or secrets in logs/traces.

## Acceptance gates before calling voice usable

### Automated tests

- Permission granted/denied/revoked and device removed during capture.
- Empty/oversized/malformed frames, duration mismatch, queue overflow, and long silence.
- Barge-in while TTS is active; old playback stops before replacement becomes audible.
- Close/logout/page-hide during capture, STT, agent execution, TTS, and playback.
- Adapter rejects on AbortSignal; cancellation resolves as a normal interrupted result,
  while genuine device failures remain visible.
- Repeated start/stop cycles do not leak tracks, contexts, worklets, native handles,
  object URLs, or listeners.
- Tests verify that no capture begins before explicit permission and user action.

### Platform smoke tests

Run on physical devices or representative native hosts for Windows, macOS, Linux,
and supported mobile/browser targets. Verify microphone permission prompts, device
selection, mute, interruption latency, playback output, device removal, and cleanup.
CI mocks and controller unit tests are not substitutes for these checks.

## Implementation order

1. Choose the actual supported desktop host packaging and browser client surface.
2. Add a narrow, optional host audio adapter contract with no implicit permission grant.
3. Implement and test one platform end-to-end before expanding to other platforms.
4. Add cross-platform implementations only after dependency/license/packaging review.
5. Complete automated lifecycle tests and physical-device smoke tests.
6. Keep voice disabled by default until the host's permission and cleanup paths pass.

Do not mark the voice feature production-ready solely because provider or controller
unit tests pass.
