import test from "node:test";
import assert from "node:assert/strict";
import { VoiceWorkflow } from "./workflow.js";
import { createVoiceSession } from "./session.js";

const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", durationMs: 1000 };

function blockingWorkflow() {
  return new VoiceWorkflow(
    {
      transcribe: (_input, signal) => new Promise<string>((_resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    },
    async () => ({ text: "unused" }),
  );
}

test("voice session serializes turns and returns to idle after a successful turn", async () => {
  const workflow = new VoiceWorkflow(
    { async transcribe() { return "hello"; } },
    async () => ({ text: "hello back" }),
  );
  const session = createVoiceSession(workflow);
  const result = await session.processTurn(audio);
  assert.equal(result.transcript, "hello");
  assert.deepEqual(session.snapshot(), { state: "idle", turnId: 1 });
});

test("voice session interrupt aborts the active turn and does not accept overlap before settlement", async () => {
  const session = createVoiceSession(blockingWorkflow());
  const turn = session.processTurn(audio);
  assert.deepEqual(session.snapshot(), { state: "processing", turnId: 1 });
  await assert.rejects(session.processTurn(audio), /active turn/);
  assert.equal(session.interrupt(), true);
  assert.deepEqual(session.snapshot(), { state: "interrupting", turnId: 1 });
  await assert.rejects(turn, /Voice turn interrupted/);
  assert.deepEqual(session.snapshot(), { state: "idle", turnId: 1 });
  assert.equal(session.interrupt(), false);
});

test("closing a voice session cancels its active turn and cannot be reopened", async () => {
  const session = createVoiceSession(blockingWorkflow());
  const turn = session.processTurn(audio);
  session.close();
  assert.deepEqual(session.snapshot(), { state: "closed", turnId: 1 });
  await assert.rejects(turn, /Voice session closed/);
  await assert.rejects(session.processTurn(audio), /closed/);
  session.close();
  assert.deepEqual(session.snapshot(), { state: "closed", turnId: 1 });
});

test("voice session forwards external cancellation to the active workflow", async () => {
  const session = createVoiceSession(blockingWorkflow());
  const controller = new AbortController();
  const turn = session.processTurn(audio, controller.signal);
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(turn, /caller cancelled/);
  assert.deepEqual(session.snapshot(), { state: "idle", turnId: 1 });
});
