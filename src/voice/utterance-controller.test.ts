import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceUtteranceController } from "./utterance-controller.js";
import { createVoiceSession } from "./session.js";
import { VoiceWorkflow } from "./workflow.js";

const frame = (value: number) => ({ bytes: new Uint8Array([value]), durationMs: 20 });
const session = (seen: number[]) => createVoiceSession(new VoiceWorkflow(
  { async transcribe(input) { seen.push(input.bytes[0] ?? 0); return "hello"; } },
  async () => ({ text: "reply" }),
));

test("utterance controller exports its factory", () => {
  assert.equal(typeof createVoiceUtteranceController, "function");
});

test("pre-roll is included in a completed utterance and the session receives one turn", async () => {
  const seen: number[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let reply = "";
  const controller = createVoiceUtteranceController({
    session: session(seen), mimeType: "audio/wav",
    activity: { frameDurationMs: 20, minSpeechMs: 40, endSilenceMs: 40, maxUtteranceMs: 1000 },
    preRoll: { maxDurationMs: 60, maxBytes: 10 },
    onTurnResult(result) { reply = result.replyText; finish(); },
  });
  controller.pushFrame(frame(1), 0);
  controller.pushFrame(frame(2), 1);
  controller.pushFrame(frame(3), 1);
  controller.pushFrame(frame(4), 1);
  controller.pushFrame(frame(5), 0);
  controller.pushFrame(frame(6), 0);
  await done;
  assert.deepEqual(seen, [1]);
  assert.equal(reply, "reply");
  controller.close();
});

test("close clears buffered pre-roll and rejects later frames", () => {
  const controller = createVoiceUtteranceController({ session: session([]), mimeType: "audio/wav" });
  controller.pushFrame(frame(1), 0);
  assert.equal(controller.snapshot().bufferedBytes, 1);
  controller.close();
  assert.deepEqual(controller.snapshot(), { state: "closed", bufferedBytes: 0 });
  assert.throws(() => controller.pushFrame(frame(2), 0), /closed/);
});
