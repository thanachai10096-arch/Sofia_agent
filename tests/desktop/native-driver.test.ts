import assert from "node:assert/strict";
import test from "node:test";
import { createNativeDesktopDriver } from "../../src/desktop/native-driver.js";

test("native driver refuses unmapped applications and model-provided launch arguments", async () => {
  const driver = createNativeDesktopDriver({
    platform: "linux",
    applications: { editor: { executable: "/usr/bin/editor", args: ["--safe-mode"] } },
  });
  await assert.rejects(driver.launchApplication("terminal"), /fixed local executable mapping/);
  await assert.rejects(driver.launchApplication("editor", ["--execute=rm"]), /operator-configured fixed arguments/);
});

test("native driver rejects unsafe key names and out-of-range pointer coordinates before OS calls", async () => {
  const driver = createNativeDesktopDriver({ platform: "linux" });
  await assert.rejects(driver.pressKey("Ctrl+Alt+Delete"), /Unsupported desktop key/);
  await assert.rejects(driver.click({ x: -1, y: 0 }), /Invalid screen coordinates/);
  await assert.rejects(driver.click({ x: 0, y: 0, button: "side" as "left" }), /Invalid screen coordinates|Unsupported/);
});

test("native driver validates platform selection", () => {
  assert.throws(() => createNativeDesktopDriver({ platform: "freebsd" as "linux" }), /Unsupported desktop platform/);
});
