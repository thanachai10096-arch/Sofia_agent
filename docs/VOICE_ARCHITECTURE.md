# Sofia Agent Voice & Multichannel Architecture

Status: architecture and implementation plan. This document does not claim that every listed channel or a live speech provider is implemented.

## Goals

- Make voice an input/output capability of the existing Sofia Core, not a second agent runtime.
- Keep model selection independent from speech-to-text (STT) and text-to-speech (TTS) provider selection.
- Reuse the existing API, SDK, session/memory, tool registry, policy, approval, verification, and execution-trace contracts.
- Add channels incrementally without breaking text-only behavior or existing public interfaces.
- Keep provider credentials server-side; audio is ephemeral by default.
- Make capability claims evidence-based: mock tests, provider contract tests, and live channel smoke tests are distinct evidence levels.

## Current repository evidence

The main branch currently exports `VoiceWorkflow` and its provider contracts from `src/voice/workflow.ts` through `src/index.ts`. The workflow accepts audio bytes and host-supplied duration metadata, validates configured byte/duration/transcript limits and MIME type, calls an injected STT provider, passes the transcript to an injected Sofia-agent callback, and optionally calls an injected TTS provider. It supports cancellation and per-stage timeouts and keeps audio in memory.

The current tests in `tests/voice-workflow.test.ts` cover the workflow using mock providers, validation, text-only replies, and cancellation. These are unit-level tests, not proof of live STT/TTS integration.

Known boundaries:
- `src/voice/openai-compatible-provider.ts` now supplies an opt-in adapter for OpenAI-style audio transcription and speech endpoints. It is not auto-registered, and unit tests with mocked `fetch` do not establish live compatibility with any particular vendor. No live provider has been configured or tested.
- Duration is supplied by the host; production adapters must inspect/decode media independently and enforce actual duration and decode/resource limits.
- The workflow itself is not a browser microphone UI, a Telegram voice-message adapter, or a Discord real-time voice connection.
- The workflow is exported from the package entry point, but that alone does not prove it is wired into a running API or desktop application.
- No provider credentials or live provider calls are part of this architecture document.

## Reference architecture

```text
Web / Desktop / Mobile / CLI / API-SDK / Telegram / Discord / Slack / future channels
                                 |
                     Channel-specific adapter
        (platform authentication, identity mapping, rate limits)
                                 |
                     Normalized channel event
                                 |
                    Shared channel/session gateway
       (allowlist, dedupe, idempotency, bounded payload, audit)
                                 |
                   Input normalization pipeline
             text ----------------+---------------- audio
                                  |                    |
                                  |             Audio validation
                                  |                    |
                                  |               STT provider
                                  |                    |
                                  +------ normalized transcript
                                                       |
                                      Existing Sofia API / SDK
                                                       |
                          Sofia Core: plan -> act -> observe -> verify
                           policy / approvals / tools / memory / trace
                                                       |
                                          normalized text result
                                                       |
                                      Optional output rendering
                                          |                 |
                                        text          optional TTS
                                          |                 |
                                   channel adapter -> text/audio response
```

Important boundaries:
- Channel adapters authenticate and normalize events; they do not call tools or create their own agent runtime.
- STT converts media to text. The transcript is untrusted user input and enters the ordinary Sofia request and policy path.
- TTS speaks an already-produced Sofia response. Audio output must not be treated as trusted commands or fed back into the same session as a new user turn.
- Model routing and speech provider routing are separate configuration concerns.
- All channels map to stable user and conversation/session identifiers. Never trust identity fields supplied inside message text or unverified payloads.
- Long-running tasks should use the existing job/runtime contracts and send status updates through the originating channel; do not hold a voice transport open while a long job runs.

## Suggested module boundaries (additive)

Use the existing `src/voice/workflow.ts` as the workflow foundation; do not replace it or create a second runtime.

- `src/voice/workflow.ts`: existing provider-injected STT → Sofia callback → optional TTS workflow.
- `src/voice/channel-handler.ts`: shared handler for verified normalized voice events, access policy, deduplication, workflow invocation, and text/audio delivery.
- `src/voice/provider-registry.ts`: explicit STT/TTS provider registration and selection, plus non-secret environment routing settings; voice stays disabled by default.
- `src/voice/openai-compatible-provider.ts`: opt-in adapter for OpenAI-style `/audio/transcriptions` and `/audio/speech` endpoints; no automatic registration or credentials are bundled.
- `src/integrations/voice/...`: future platform-specific adapters that verify platform events, safely acquire media, decode/inspect duration, and deliver responses.
- Independent media decoding, actual duration verification, a production host wiring path, and live provider/channel tests remain future work; do not claim these are complete.
- `docs/VOICE-WORKFLOW.md`: integration contract and safety requirements.

The channel handler is a shared contract, not a claim that transport adapters for all listed channels already exist. Extend existing adapters where possible and avoid parallel messaging/runtime abstractions.

## Channel coverage and rollout

| Channel | Intended voice capability | Initial order | Evidence required before marking implemented |
|---|---|---:|---|
| Core SDK/API | Provider-neutral audio turn contract; host supplies provider and identity | P0 | Contract tests, auth/policy integration tests |
| CLI | Record/upload audio where host environment permits; optional spoken response | P1 | CLI tests and actual supported-platform smoke test |
| Web chat | Browser microphone permission, recording, transcript preview, play/stop audio | P1 | Browser tests for permission denial, cancel, playback, and upload limits |
| Desktop | Host microphone and audio playback behind explicit desktop capabilities | P1 | Desktop host-driver tests; no renderer access to server secrets |
| Mobile | Record, upload, play; interruption and permission states | P2 | iOS/Android device tests and lifecycle cleanup |
| Telegram | Receive voice/audio message, transcribe, reply as text or supported audio file | P1 | Signed/authorized real bot smoke test, allowlist denial, duplicate update test |
| Discord text | Accept supported audio attachments only through a secured media-fetch path; return text/audio attachment | P1 | Attachment SSRF protections, size/time bounds, live bot test |
| Discord Voice | Join voice channel, receive stream, speak response, interruption | P3 | Voice gateway integration tests, reconnect tests, live test server |
| Slack | Audio/file events only after verified event and file-download handling | P2 | Signature verification, scoped file access, replay and live workspace tests |
| WhatsApp | Voice-note support through an approved WhatsApp provider/API | P3 | Provider-specific webhook validation, media-fetch controls, live sandbox test |
| Signal / Matrix | Evaluate separate adapter feasibility; no generic promise of support | P3 | Protocol-specific security review and integration test |
| Future channels | Implement adapters against shared contracts, not copy/paste agent logic | As needed | Adapter conformance suite and security review |

“Planned” and “provider-ready” must not be described as “live” or “supported” without the evidence above. Channel availability depends on platform APIs, deployment credentials, permissions, and policy.

## Provider routing and configuration

STT and TTS are independent from the main LLM route. A user may select configured providers or choose automatic routing among explicitly configured providers. Automatic selection must never infer consent to send audio to a newly discovered third party.

Suggested configuration shape (names are illustrative; align with existing config conventions before implementation):

- `SOFIA_VOICE_ENABLED=false` by default.
- `SOFIA_VOICE_STT_PROVIDER=<explicit configured provider>`.
- `SOFIA_VOICE_TTS_PROVIDER=<explicit configured provider or disabled>`.
- Provider credentials stored only in server-side environment/secret storage.
- Per-user settings may choose among server-approved provider IDs, language, voice, and whether to synthesize replies.
- No credential values in client bundles, logs, error messages, trace payloads, or persisted session transcripts.
- Provider failover is allowed only to another explicitly enabled provider; otherwise return a clear text fallback when safe.

The generic compatible-endpoint adapter adds no dependency. Before enabling any concrete provider in a deployment, review that provider's API compatibility, license/terms, data handling, supported formats, timeout behavior, and environment compatibility.

## Session and privacy contract

- Audio bytes remain in memory by default and are discarded after processing.
- Persist transcript text only through the existing session policy and retention settings; voice mode must not silently change retention.
- Do not persist raw audio or provider payloads by default.
- Logs contain correlation IDs, durations, provider IDs, sizes, and safe error codes—not audio, transcripts, tokens, or personal content.
- Expose a clear recording/listening indicator and explicit microphone permission UX.
- Cancellation must abort STT/TTS where supported and release buffers, streams, and timers.
- Prevent loopback: generated audio is output-only unless a user explicitly starts a new turn.
- Apply the same user/channel allowlists, rate limits, authorization, approvals, tool policies, and audit trail as text input.
- Treat transcripts as untrusted input; prompt injection in speech receives no special trust.
- Media downloads from platform URLs require a dedicated SSRF-safe fetcher: HTTPS/provider host allowlist where possible, redirect and DNS revalidation, private/loopback/link-local blocking, response byte/time limits, and no forwarding of Sofia credentials.

## Real-time conversation (later phase)

Do not begin with a full-duplex voice stack. First ship reliable push-to-talk / voice-message turns. Then add:
1. streaming STT where supported;
2. streaming text and TTS output with bounded buffers;
3. voice activity detection and end-of-turn policy;
4. barge-in cancellation that stops playback and cancels the active synthesis;
5. reconnect/resume and dropped-packet behavior;
6. echo suppression and loopback prevention;
7. per-session concurrency, CPU/memory limits, and abuse throttles.

Realtime transport must still use the same Sofia request/session and policy contract. It must not introduce a second planner, tool registry, or memory system.

## Implementation phases and exit gates

### P0 — audit and core contract
- Review current main and any voice-related PRs/diffs before integrating anything.
- Confirm the current `VoiceWorkflow` contract and export; a shared `createVoiceChannelHandler` and focused unit tests are now added on the feature branch.
- Added provider-neutral registry/config selection with explicit provider IDs and feature-off default. Next: wire a real provider in Test Environment and add independent media decoding/validation.
- Add media validation independent of untrusted duration metadata.
- Exit: typecheck/build/tests pass; disabled voice does not change current behavior.

### P1 — one real provider pair and message channels
- A generic OpenAI-compatible STT/TTS adapter and mocked provider-contract tests are now on the feature branch; it is not live-certified for any vendor.
- Select and validate one actual provider behind the existing interfaces; add no provider-specific logic to the core workflow.
- Wire a single API/SDK host entry point; test one real audio turn end-to-end in a non-production environment.
- Add Telegram voice-message handling; then Discord text attachment support only after SSRF-safe media fetching exists.
- Exit: real provider smoke test, allowlist and replay tests, provider failure fallback, no secrets in logs.

### P2 — user-facing clients and more channels
- Add Web microphone UX, then Desktop host capability integration, then Mobile.
- Add Slack only with provider-specific authentication and file access.
- Exit: browser/device tests, permission denial/cancellation tests, accessibility checks, and adapter conformance tests.

### P3 — realtime and additional platforms
- Discord Voice, WhatsApp voice notes, and protocol-specific Signal/Matrix exploration.
- Add streaming, interruption, reconnection, echo/loopback controls.
- Exit: live sandbox test, resource/latency tests, abuse tests, and security review.

## Test matrix

Required automated tests:
- invalid MIME, empty payload, oversized payload, malformed media, and decoded duration over limit;
- STT timeout, TTS timeout, abort before/during/after each stage, provider exception and malformed response;
- empty/oversized transcript and empty/oversized TTS output;
- transcript reaches the existing agent callback exactly once and uses normal policy;
- no tools run from an unauthorized user or channel;
- no duplicate task on webhook replay or transport retry;
- no audio/transcript/secret leakage in logs;
- generated audio is not re-ingested as a user turn;
- feature disabled preserves text-only behavior;
- per-adapter authentication/signature, allowlist, rate limit, and bounded payload tests;
- build, typecheck, relevant unit tests, and full regression suite.

Evidence levels:
1. Unit/mock tests: workflow logic only.
2. Provider contract tests: adapter behavior against provider fixtures or a test endpoint.
3. Live sandbox smoke test: real credentials and platform test account.
4. Production readiness: all relevant checks plus deployment-specific security review. Do not infer level 3 or 4 from levels 1 or 2.

## Definition of done

- [ ] Existing text workflows and public APIs remain backward compatible.
- [ ] Voice is disabled by default until explicit configuration and permissions exist.
- [ ] At least one STT/TTS pair works in a non-production live test.
- [ ] The transcript follows existing Sofia Core, authorization, policy, memory, tool, and verification paths.
- [ ] Provider selection is explicit and independent from LLM selection.
- [ ] Each implemented channel passes adapter-specific tests.
- [ ] Audio retention and logging follow the privacy contract.
- [ ] No Production deployment or secret change occurs as part of this architecture task.
- [ ] Readiness reports separate implemented code, passing automated tests, live-tested providers, and planned channels.
