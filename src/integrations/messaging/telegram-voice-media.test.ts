import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramVoiceMediaClient } from "./telegram-voice-media.js";

const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";

test("Telegram voice media downloads only from the fixed Telegram file origin", async () => {
  const urls: string[] = [];
  const client = createTelegramVoiceMediaClient({
    token,
    fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/getFile")) {
        return Response.json({ ok: true, result: { file_path: "voice/file_42.oga", file_size: 3 } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
    },
  });
  const result = await client.downloadVoice("file-id", new AbortController().signal);
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(result.mimeType, "audio/ogg");
  assert.equal(urls[0], "https://api.telegram.org/bot" + token + "/getFile");
  assert.equal(urls[1], "https://api.telegram.org/file/bot" + token + "/voice/file_42.oga");
});

test("Telegram voice media rejects unsafe file paths and unsupported extensions", async () => {
  for (const filePath of ["../secret.oga", "voice/%2e%2e/file.oga", "voice\\file.oga", "voice/file.exe"]) {
    const client = createTelegramVoiceMediaClient({
      token,
      fetchImpl: async () => Response.json({ ok: true, result: { file_path: filePath } }),
    });
    await assert.rejects(
      client.downloadVoice("file-id", new AbortController().signal),
      /invalid file path|not supported/,
    );
  }
});

test("Telegram voice media enforces metadata and streaming download limits", async () => {
  const tooLargeMetadata = createTelegramVoiceMediaClient({
    token,
    maxDownloadBytes: 4,
    fetchImpl: async () => Response.json({ ok: true, result: { file_path: "voice/a.oga", file_size: 5 } }),
  });
  await assert.rejects(
    tooLargeMetadata.downloadVoice("file-id", new AbortController().signal),
    /exceeds configured byte limit/,
  );

  const streamed = createTelegramVoiceMediaClient({
    token,
    maxDownloadBytes: 4,
    fetchImpl: async (input) => String(input).endsWith("/getFile")
      ? Response.json({ ok: true, result: { file_path: "voice/a.oga" } })
      : new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array(5)); controller.close(); },
        })),
  });
  await assert.rejects(
    streamed.downloadVoice("file-id", new AbortController().signal),
    /exceeds configured byte limit/,
  );
});

test("Telegram voice media uploads audio as multipart without manual content type", async () => {
  let capturedUrl = "";
  let capturedBody: FormData | undefined;
  const client = createTelegramVoiceMediaClient({
    token,
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedBody = init?.body as FormData;
      assert.equal(new Headers(init?.headers).has("content-type"), false);
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  await client.sendVoice("-100123", { bytes: new Uint8Array([1, 2]), mimeType: "audio/ogg" }, new AbortController().signal);
  assert.equal(capturedUrl, "https://api.telegram.org/bot" + token + "/sendVoice");
  assert.equal(capturedBody?.get("chat_id"), "-100123");
  assert.equal((capturedBody?.get("voice") as File).type, "audio/ogg");
});

test("Telegram voice media rejects invalid identifiers and cancelled operations", async () => {
  const client = createTelegramVoiceMediaClient({ token, fetchImpl: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(client.downloadVoice("../bad", new AbortController().signal), /file ID is invalid/);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(client.downloadVoice("file-id", controller.signal), /cancelled/);
  await assert.rejects(
    client.sendVoice("not-a-chat", { bytes: new Uint8Array([1]), mimeType: "audio/ogg" }, new AbortController().signal),
    /chat ID is invalid/,
  );
});
