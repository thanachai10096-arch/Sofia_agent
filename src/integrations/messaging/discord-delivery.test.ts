import assert from "node:assert/strict";
import test from "node:test";
import { sendDiscordText } from "./discord-delivery.js";

test("Discord delivery sends every chunk and uses interaction token only once", async () => {
  const calls: Array<{ channelId: string; text: string; replyTo?: string; interactionId?: string }> = [];
  const transport = {
    async sendMessage(channelId: string, text: string, replyTo?: string, interactionId?: string) {
      calls.push({ channelId, text, ...(replyTo ? { replyTo } : {}), ...(interactionId ? { interactionId } : {}) });
      return { messageId: String(calls.length) };
    },
  };
  const output = "🙂".repeat(2_600) + " final result";
  await sendDiscordText(transport, "123456789", output, "interaction-1");

  assert.ok(calls.length > 1);
  assert.equal(calls.map((call) => call.text).join(""), output);
  assert.ok(calls.every((call) => call.channelId === "123456789"));
  assert.ok(calls.every((call) => call.text.length <= 1_700));
  assert.equal(calls[0]?.interactionId, "interaction-1");
  assert.ok(calls.slice(1).every((call) => call.interactionId === undefined));
  assert.ok(calls.every((call) => {
    const first = call.text.charCodeAt(0);
    const last = call.text.charCodeAt(call.text.length - 1);
    return !(first >= 0xdc00 && first <= 0xdfff) && !(last >= 0xd800 && last <= 0xdbff);
  }));
});

test("Discord delivery sends an empty result as one message", async () => {
  const messages: string[] = [];
  const transport = { async sendMessage(_channelId: string, text: string) {
    messages.push(text);
    return { messageId: String(messages.length) };
  } };
  await sendDiscordText(transport, "123456789", "");
  assert.deepEqual(messages, [""]);
});
