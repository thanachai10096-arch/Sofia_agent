import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceUtteranceController } from "./utterance-controller.js";
test("utterance controller module exports its factory", () => {
  assert.equal(typeof createVoiceUtteranceController, "function");
});
