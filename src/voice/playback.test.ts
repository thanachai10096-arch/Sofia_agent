import test from "node:test";
import assert from "node:assert/strict";
import { createVoicePlaybackController } from "./playback.js";

const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav" };

test("interrupt aborts active playback and waits for host stop", async () => {
  let receivedSignal!: AbortSignal;
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let stopped = 0;
  const controller = createVoicePlaybackController({
    play: async (_audio, signal) => {
      receivedSignal = signal;
      start();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    stop() { stopped++; },
  });
  const playing = controller.play(audio);
  await started;
  await controller.interrupt();
  assert.equal(receivedSignal.aborted, true);
  assert.equal(stopped, 2);
  assert.equal(await playing, false);
  assert.equal(controller.snapshot().state, "idle");
  await controller.close();
});

test("a newer playback supersedes a pending older request", async () => {
  const started: string[] = [];
  let firstStart!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstStart = resolve; });
  const controller = createVoicePlaybackController({
    async play(item, signal) {
      started.push(String(item.bytes[0]));
      if (item.bytes[0] === 1) {
        firstStart();
        await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
    },
    stop() {},
  });
  const first = controller.play(audio);
  await firstStarted;
  const second = controller.play({ bytes: new Uint8Array([9]), mimeType: "audio/mpeg" });
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(started, ["1", "9"]);
  await controller.close();
});

test("close stops output and rejects later playback", async () => {
  let stopped = 0;
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const controller = createVoicePlaybackController({
    async play(_audio, signal) {
      start();
      await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
    stop() { stopped++; },
  });
  const playing = controller.play(audio);
  await started;
  await controller.close();
  assert.equal(await playing, false);
  assert.equal(stopped, 2);
  assert.equal(controller.snapshot().state, "closed");
  await assert.rejects(controller.play(audio), /closed/);
});
