import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceActivityDetector } from "./activity.js";

test("VAD requires sustained speech before opening an utterance", () => {
  const vad = createVoiceActivityDetector({ frameDurationMs: 20, minSpeechMs: 60 });
  assert.deepEqual(vad.push(0.9), []);
  assert.deepEqual(vad.push(0.9), []);
  assert.deepEqual(vad.push(0.9), [{ type: "started", atMs: 0 }]);
  assert.equal(vad.snapshot().active, true);
});

test("VAD uses hysteresis and closes only after sustained silence", () => {
  const vad = createVoiceActivityDetector({
    frameDurationMs: 20, minSpeechMs: 40, endSilenceMs: 60,
    startThreshold: 0.7, stopThreshold: 0.4,
  });
  vad.push(0.8);
  vad.push(0.8);
  assert.deepEqual(vad.push(0.5), []);
  assert.equal(vad.snapshot().active, true);
  assert.deepEqual(vad.push(0.2), []);
  assert.deepEqual(vad.push(0.2), []);
  assert.deepEqual(vad.push(0.2), [{
    type: "ended", atMs: 120, durationMs: 60, reason: "silence",
  }]);
  assert.equal(vad.snapshot().active, false);
});

test("VAD enforces a maximum utterance duration", () => {
  const vad = createVoiceActivityDetector({ frameDurationMs: 20, minSpeechMs: 20, maxUtteranceMs: 60 });
  assert.deepEqual(vad.push(1), [{ type: "started", atMs: 0 }]);
  assert.deepEqual(vad.push(1), []);
  assert.deepEqual(vad.push(1), [{
    type: "ended", atMs: 60, durationMs: 60, reason: "max-duration",
  }]);
  assert.equal(vad.snapshot().active, false);
});

test("VAD resets elapsed time and rejects invalid probabilities and thresholds", () => {
  const vad = createVoiceActivityDetector();
  assert.throws(() => vad.push(Number.NaN), /probability/);
  assert.throws(() => createVoiceActivityDetector({ stopThreshold: 0.8, startThreshold: 0.7 }), /stopThreshold/);
  vad.push(1);
  vad.reset();
  assert.deepEqual(vad.snapshot(), { elapsedMs: 0, active: false, candidateMs: 0, silenceMs: 0 });
});
