import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import type { Sandbox, SandboxLimits } from "../../sandbox.js";
import { createSandboxedTelegramAudioInspector } from "./telegram-audio-inspector.js";

function sandboxWith(
  output: { stdout: string; stderr: string; code: number },
  inspect?: (command: string, args: string[], limits: SandboxLimits, signal?: AbortSignal) => Promise<void>,
): Sandbox {
  return {
    isolation: "container",
    async run(command, args, limits, signal) {
      await inspect?.(command, args, limits, signal);
      return output;
    },
  };
}

const metadata = JSON.stringify({
  format: { duration: "2.501", format_name: "ogg" },
  streams: [{ codec_type: "audio" }],
});

test("sandboxed Telegram inspector uses ffprobe in a dedicated network-disabled container workspace", async () => {
  let workspace = "";
  const inspector = createSandboxedTelegramAudioInspector({
    sandbox: sandboxWith({ stdout: metadata, stderr: "", code: 0 }, async (command, args, limits) => {
      assert.equal(command, "ffprobe");
      assert.deepEqual(args.slice(0, 2), ["-v", "error"]);
      assert.equal(args.at(-1), "/workspace/input.audio");
      assert.equal(limits.allowNetwork, false);
      assert.equal(limits.timeoutMs, 10_000);
      workspace = limits.workspaceRoot;
      assert.deepEqual([...await readFile(workspace + "/input.audio")], [1, 2, 3]);
    }),
  });

  assert.deepEqual(await inspector.inspect({
    bytes: new Uint8Array([1, 2, 3]),
    declaredMimeType: "audio/unknown",
    signal: new AbortController().signal,
  }), { mimeType: "audio/ogg", durationMs: 2501 });
  await assert.rejects(access(workspace), /ENOENT/);
});

test("sandboxed Telegram inspector maps supported containers and rejects unsupported formats", async () => {
  const make = (formatName: string) => createSandboxedTelegramAudioInspector({
    sandbox: sandboxWith({
      stdout: JSON.stringify({ format: { duration: "1.25", format_name: formatName }, streams: [{ codec_type: "audio" }] }),
      stderr: "",
      code: 0,
    }),
  });
  assert.equal((await make("mp3").inspect({ bytes: new Uint8Array([1]), signal: new AbortController().signal })).mimeType, "audio/mpeg");
  assert.equal((await make("wav").inspect({ bytes: new Uint8Array([1]), signal: new AbortController().signal })).mimeType, "audio/wav");
  await assert.rejects(make("matroska").inspect({ bytes: new Uint8Array([1]), signal: new AbortController().signal }), /not supported/);
});

test("sandboxed Telegram inspector rejects non-container isolation", () => {
  const processSandbox = { isolation: "process", async run() { return { stdout: "", stderr: "", code: 0 }; } } as unknown as Sandbox;
  assert.throws(() => createSandboxedTelegramAudioInspector({ sandbox: processSandbox }), /ContainerSandbox/);
});

test("sandboxed Telegram inspector rejects absent audio streams, invalid duration, and decoder failures", async () => {
  const create = (stdout: string, code = 0) => createSandboxedTelegramAudioInspector({
    sandbox: sandboxWith({ stdout, stderr: "private decoder details", code }),
  });
  await assert.rejects(create(JSON.stringify({ format: { duration: "1", format_name: "ogg" }, streams: [{ codec_type: "video" }] }))
    .inspect({ bytes: new Uint8Array([1]), signal: new AbortController().signal }), /no audio stream/);
  await assert.rejects(create(JSON.stringify({ format: { duration: "NaN", format_name: "ogg" }, streams: [{ codec_type: "audio" }] }))
    .inspect({ bytes: new Uint8Array([1]), signal: new AbortController().signal }), /duration could not be verified/);
  await assert.rejects(create("{}", 1).inspect({ bytes: new Uint8Array([1]), signal: new AbortController().signal }), /rejected the media/);
});

test("sandboxed Telegram inspector enforces byte and duration limits before accepting metadata", async () => {
  const inspector = createSandboxedTelegramAudioInspector({
    sandbox: sandboxWith({
      stdout: JSON.stringify({ format: { duration: "3", format_name: "ogg" }, streams: [{ codec_type: "audio" }] }),
      stderr: "",
      code: 0,
    }),
    maxInputBytes: 2,
    maxDurationMs: 2000,
  });
  await assert.rejects(inspector.inspect({ bytes: new Uint8Array([1, 2, 3]), signal: new AbortController().signal }), /byte limits/);
  await assert.rejects(inspector.inspect({ bytes: new Uint8Array([1]), signal: new AbortController().signal }), /duration exceeds/);
});

test("sandboxed Telegram inspector forwards cancellation and output bounds and cleans up after sandbox failure", async () => {
  const controller = new AbortController();
  let workspace = "";
  const inspector = createSandboxedTelegramAudioInspector({
    sandbox: sandboxWith({ stdout: "", stderr: "", code: 1 }, async (_command, _args, limits, signal) => {
      workspace = limits.workspaceRoot;
      assert.equal(limits.maxOutputBytes, 1234);
      assert.equal(signal, controller.signal);
      assert.deepEqual([...await readFile(workspace + "/input.audio")], [9, 8, 7]);
      throw new Error("sandbox runner failed");
    }),
    maxOutputBytes: 1234,
  });

  await assert.rejects(
    inspector.inspect({ bytes: new Uint8Array([9, 8, 7]), signal: controller.signal }),
    /sandbox runner failed/,
  );
  await assert.rejects(access(workspace), /ENOENT/);
});

test("sandboxed Telegram inspector rejects an already-aborted signal before creating a workspace", async () => {
  const controller = new AbortController();
  controller.abort();
  let invoked = false;
  const inspector = createSandboxedTelegramAudioInspector({
    sandbox: sandboxWith({ stdout: metadata, stderr: "", code: 0 }, async () => { invoked = true; }),
  });
  await assert.rejects(
    inspector.inspect({ bytes: new Uint8Array([1]), signal: controller.signal }),
  );
  assert.equal(invoked, false);
});
