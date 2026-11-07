import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformDesktopHostDriver, type NativeCommandRunner } from "./platform-host.js";

function fakePng(width = 800, height = 600): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test("Linux X11 driver uses direct xdotool arguments and captures a bounded PNG", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const run: NativeCommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { stdout: command === "scrot" ? fakePng() : Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const driver = createPlatformDesktopHostDriver({ platform: "linux", env: { DISPLAY: ":0" }, run });
  const image = await driver.captureScreen();
  assert.equal(image.width, 800);
  assert.equal(image.height, 600);
  await driver.click({ x: 25, y: 40, button: "right" });
  await driver.typeText("hello; do-not-run");
  await driver.pressKey("Ctrl+A");
  assert.equal(calls[0]?.command, "scrot");
  assert.deepEqual(calls[1]?.args, ["mousemove", "--sync", "25", "40", "click", "3"]);
  assert.deepEqual(calls[2]?.args, ["type", "--clearmodifiers", "--delay", "1", "--", "hello; do-not-run"]);
  assert.deepEqual(calls[3]?.args, ["key", "--clearmodifiers", "ctrl+a"]);
});

test("Linux Wayland refuses X11-only input and capture backends", async () => {
  let called = false;
  const run: NativeCommandRunner = async () => {
    called = true;
    return { stdout: fakePng(), stderr: Buffer.alloc(0) };
  };
  const driver = createPlatformDesktopHostDriver({
    platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, run,
  });
  await assert.rejects(driver.captureScreen(), /Wayland/);
  await assert.rejects(driver.click({ x: 0, y: 0 }), /Wayland/);
  await assert.rejects(driver.typeText("test"), /Wayland/);
  assert.equal(called, false);
});

test("macOS uses native screenshot and cliclick arguments without a shell", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const run: NativeCommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { stdout: command.endsWith("screencapture") ? fakePng(1024, 768) : Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const driver = createPlatformDesktopHostDriver({ platform: "darwin", run });
  const image = await driver.captureScreen();
  assert.equal(image.width, 1024);
  await driver.click({ x: 12, y: 34, button: "left" });
  await driver.typeText("safe text");
  await driver.pressKey("Ctrl+A");
  assert.equal(calls[0]?.command, "/usr/sbin/screencapture");
  assert.deepEqual(calls[1]?.args, ["m:12,34", "c:12,34"]);
  assert.deepEqual(calls[2]?.args, ["t:safe text"]);
  assert.deepEqual(calls[3]?.args, ["kd:CTRL", "kp:A", "ku:CTRL"]);
});

test("Windows input data is passed as environment values, not command text", async () => {
  const calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const run: NativeCommandRunner = async (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const driver = createPlatformDesktopHostDriver({ platform: "win32", run });
  const sensitive = "do not interpret; $env:PATH";
  await driver.typeText(sensitive);
  await driver.click({ x: 40, y: 50, button: "middle" });
  await driver.pressKey("Ctrl+A");
  assert.equal(calls[0]?.command, "powershell.exe");
  assert.equal(calls[0]?.args.includes(sensitive), false);
  assert.equal(calls[0]?.env?.SOFIA_NATIVE_TEXT, sensitive);
  assert.equal(calls[1]?.env?.SOFIA_NATIVE_X, "40");
  assert.equal(calls[1]?.env?.SOFIA_NATIVE_BUTTON, "middle");
  assert.equal(calls[2]?.env?.SOFIA_NATIVE_VK, "65");
  assert.equal(calls[2]?.env?.SOFIA_NATIVE_MODIFIERS, "CTRL");
  assert.equal(calls.every((call) => !call.args.some((arg) => arg.includes("do not interpret"))), true);
});

test("unsupported platforms fail closed", async () => {
  const driver = createPlatformDesktopHostDriver({ platform: "freebsd" as NodeJS.Platform });
  await assert.rejects(driver.captureScreen(), /not supported/);
  await assert.rejects(driver.click({ x: 1, y: 1 }), /not supported/);
});
