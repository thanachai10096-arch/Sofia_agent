import test from "node:test";
import assert from "node:assert/strict";
import { createVoicePreRollBuffer } from "./pre-roll.js";

test("pre-roll keeps only the newest frames within duration and byte budgets", () => {
  const buffer = createVoicePreRollBuffer({ maxDurationMs: 60, maxBytes: 5 });
  buffer.push({ bytes: new Uint8Array([1, 2]), durationMs: 20 });
  buffer.push({ bytes: new Uint8Array([3, 4]), durationMs: 20 });
  buffer.push({ bytes: new Uint8Array([5, 6]), durationMs: 20 });
  const snapshot = buffer.snapshot();
  assert.deepEqual(snapshot.frames.map((frame) => [...frame.bytes]), [[3, 4], [5, 6]]);
  assert.equal(snapshot.durationMs, 40);
  assert.equal(snapshot.bytes, 4);
});

test("pre-roll copies inserted and returned bytes", () => {
  const buffer = createVoicePreRollBuffer();
  const source = new Uint8Array([1, 2]);
  buffer.push({ bytes: source, durationMs: 20 });
  source[0] = 9;
  const first = buffer.snapshot();
  assert.deepEqual([...first.frames[0]!.bytes], [1, 2]);
  first.frames[0]!.bytes[0] = 8;
  assert.deepEqual([...buffer.snapshot().frames[0]!.bytes], [1, 2]);
});

test("take returns copied frames and clears retained audio", () => {
  const buffer = createVoicePreRollBuffer();
  buffer.push({ bytes: new Uint8Array([1]), durationMs: 20 });
  const frames = buffer.take();
  assert.deepEqual([...frames[0]!.bytes], [1]);
  assert.deepEqual(buffer.snapshot(), { frames: [], durationMs: 0, bytes: 0 });
  frames[0]!.bytes[0] = 7;
  assert.deepEqual(buffer.snapshot().frames, []);
});

test("pre-roll rejects invalid frames and configuration", () => {
  assert.throws(() => createVoicePreRollBuffer({ maxDurationMs: 6000 }), /maxDurationMs/);
  assert.throws(() => createVoicePreRollBuffer({ maxBytes: 5 * 1024 * 1024 }), /maxBytes/);
  const buffer = createVoicePreRollBuffer();
  assert.throws(() => buffer.push({ bytes: new Uint8Array(), durationMs: 20 }), /non-empty/);
  assert.throws(() => buffer.push({ bytes: new Uint8Array([1]), durationMs: 0 }), /duration/);
});
