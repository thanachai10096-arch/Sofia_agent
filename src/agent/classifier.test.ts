import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseSinglePassConversation } from "./classifier.js";

test("ordinary conversation is eligible for the single-pass low-token path", () => {
  assert.equal(shouldUseSinglePassConversation("Hi Sofia, how are you?"), true);
  assert.equal(shouldUseSinglePassConversation("What is an AI agent?"), true);
  assert.equal(shouldUseSinglePassConversation("สวัสดี Sofia"), true);
});

test("tasks that imply actions or specialist work keep the full Brain path", () => {
  assert.equal(shouldUseSinglePassConversation("Fix the bug in this TypeScript code"), false);
  assert.equal(shouldUseSinglePassConversation("Research the latest agent frameworks"), false);
  assert.equal(shouldUseSinglePassConversation("ทำมาให้หน่อย"), false);
  assert.equal(shouldUseSinglePassConversation("ตรวจสอบโค้ดทั้งหมด"), false);
});

test("large prompts do not enter the single-pass shortcut", () => {
  assert.equal(shouldUseSinglePassConversation("What is this? " + "x".repeat(1_300)), false);
});
