import test from "node:test";
import assert from "node:assert/strict";
import { iterateBoundedVoiceAudio, type VoiceAudioChunk } from "./audio-stream.js";

async function* chunks(items: VoiceAudioChunk[]) {
  for (const item of items) yield item;
}

test("bounded audio stream yields ordered defensive copies without concatenating", async () => {
  const original = new Uint8Array([1, 2]);
  const result = [];
  for await (const chunk of iterateBoundedVoiceAudio(chunks([
    { sequence: 0, bytes: original },
    { sequence: 1, bytes: new Uint8Array([3]), final: true },
  ]))) result.push(chunk);

  assert.deepEqual(result.map((item) => item.sequence), [0, 1]);
  assert.deepEqual([...result[0]!.bytes], [1, 2]);
  original[0] = 99;
  assert.deepEqual([...result[0]!.bytes], [1, 2]);
  assert.equal(result[1]!.final, true);
});

test("bounded audio stream rejects gaps, duplicates, and data after final", async () => {
  await assert.rejects(async () => {
    for await (const _chunk of iterateBoundedVoiceAudio(chunks([
      { sequence: 1, bytes: new Uint8Array([1]) },
    ]))) { /* consume */ }
  }, /sequence/);

  await assert.rejects(async () => {
    for await (const _chunk of iterateBoundedVoiceAudio(chunks([
      { sequence: 0, bytes: new Uint8Array([1]), final: true },
      { sequence: 1, bytes: new Uint8Array([2]) },
    ]))) { /* consume */ }
  }, /after final/);
});

test("bounded audio stream enforces chunk, total-byte, and chunk-count limits", async () => {
  await assert.rejects(async () => {
    for await (const _chunk of iterateBoundedVoiceAudio(
      chunks([{ sequence: 0, bytes: new Uint8Array(3) }]),
      { maxChunkBytes: 2 },
    )) { /* consume */ }
  }, /chunk exceeds/);

  await assert.rejects(async () => {
    for await (const _chunk of iterateBoundedVoiceAudio(
      chunks([
        { sequence: 0, bytes: new Uint8Array(2) },
        { sequence: 1, bytes: new Uint8Array(2) },
      ]),
      { maxTotalBytes: 3 },
    )) { /* consume */ }
  }, /total byte limit/);

  await assert.rejects(async () => {
    for await (const _chunk of iterateBoundedVoiceAudio(
      chunks([
        { sequence: 0, bytes: new Uint8Array([1]) },
        { sequence: 1, bytes: new Uint8Array([2]) },
      ]),
      { maxChunks: 1 },
    )) { /* consume */ }
  }, /chunk count/);
});

test("bounded audio stream rejects empty chunks and empty streams", async () => {
  await assert.rejects(async () => {
    for await (const _chunk of iterateBoundedVoiceAudio(chunks([]))) { /* consume */ }
  }, /empty/);

  await assert.rejects(async () => {
    for await (const _chunk of iterateBoundedVoiceAudio(chunks([
      { sequence: 0, bytes: new Uint8Array() },
    ]))) { /* consume */ }
  }, /non-empty/);
});

test("bounded audio stream observes cancellation between chunks", async () => {
  const controller = new AbortController();
  async function* source() {
    yield { sequence: 0, bytes: new Uint8Array([1]) };
    controller.abort(new Error("stream cancelled"));
    yield { sequence: 1, bytes: new Uint8Array([2]) };
  }
  const received = [];
  await assert.rejects(async () => {
    for await (const chunk of iterateBoundedVoiceAudio(source(), {}, controller.signal)) {
      received.push(chunk);
    }
  }, /stream cancelled/);
  assert.equal(received.length, 1);
});
