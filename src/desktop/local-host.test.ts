import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAllowlistedDesktopHostDriver, describeDesktopAction, parseDesktopApplicationAllowlist, resolveLocalDesktopCapabilities } from "./local-host.js";

test("local desktop allowlist accepts only existing absolute executable files", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-local-host-"));
  const executable = path.join(directory, "app");
  try {
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    const parsed = parseDesktopApplicationAllowlist(JSON.stringify({ editor: executable }));
    assert.equal(parsed.editor, realpathSync(executable));
    assert.throws(() => parseDesktopApplicationAllowlist(JSON.stringify({ editor: "relative/app" })), /absolute executable/);
    assert.throws(() => parseDesktopApplicationAllowlist(JSON.stringify({ editor: path.join(directory, "missing") })));
    if (process.platform !== "win32") {
      assert.throws(
        () => parseDesktopApplicationAllowlist(JSON.stringify({ shell: "/bin/sh" })),
        /command interpreters/,
      );
    }
    assert.throws(() => parseDesktopApplicationAllowlist("[]"), /JSON object/);
    assert.throws(() => parseDesktopApplicationAllowlist("{"), /JSON object/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("allowlisted local host launches an exact executable without a shell", async () => {
  if (process.platform === "win32") return;
  const executable = "/usr/bin/true";
  const applications = parseDesktopApplicationAllowlist(JSON.stringify({ harmless: executable }));
  const driver = createAllowlistedDesktopHostDriver(applications);
  assert.deepEqual(await driver.launchApplication("harmless", []), { launched: true, applicationId: "harmless" });
});

test("initial local host fails closed for screen and input controls", async () => {
  const driver = createAllowlistedDesktopHostDriver({});
  await assert.rejects(driver.captureScreen(), /not enabled/);
  await assert.rejects(driver.click({ x: 1, y: 1 }), /not enabled/);
  await assert.rejects(driver.typeText("hello"), /not enabled/);
  await assert.rejects(driver.pressKey("Enter"), /not enabled/);
  await assert.rejects(driver.launchApplication("not-approved"), /not allowlisted/);
});

test("local approval summary never hides the target application or arguments", () => {
  assert.match(describeDesktopAction({ kind: "app.launch", applicationId: "editor", args: ["--safe"] }), /editor/);
  assert.match(describeDesktopAction({ kind: "app.launch", applicationId: "editor", args: ["--safe"] }), /--safe/);
});

test("local desktop capabilities allow screen-only and input-only setups without app launch", () => {
  assert.deepEqual(resolveLocalDesktopCapabilities({}, { enableInput: false, enableScreenCapture: true }), ["screen:capture"]);
  assert.deepEqual(resolveLocalDesktopCapabilities({}, { enableInput: true, enableScreenCapture: false }), ["input:control"]);
  assert.deepEqual(resolveLocalDesktopCapabilities({}, { enableInput: true, enableScreenCapture: true }), ["input:control", "screen:capture"]);
  assert.throws(() => resolveLocalDesktopCapabilities({}, { enableInput: false, enableScreenCapture: false }), /No local desktop capability/);
  assert.deepEqual(resolveLocalDesktopCapabilities({ editor: "/usr/bin/code" }, { enableInput: false, enableScreenCapture: false }), ["app:launch"]);
  assert.deepEqual(resolveLocalDesktopCapabilities({ editor: "/usr/bin/code" }, { enableInput: true, enableScreenCapture: true }), ["app:launch", "input:control", "screen:capture"]);
});


test("allowlisted local host aborts a pending application spawn", async () => {
  const applications = Object.freeze({ harmless: "/usr/bin/true" });
  let killed = false;
  let unrefed = false;
  const driver = createAllowlistedDesktopHostDriver(applications, {
    spawnImpl: () => ({
      once() { return this; },
      kill() { killed = true; return true; },
      unref() { unrefed = true; },
    }),
  });
  const controller = new AbortController();
  const launching = driver.launchApplication("harmless", [], controller.signal);
  controller.abort(new Error("operator cancelled"));
  await assert.rejects(launching, /operator cancelled/);
  assert.equal(killed, true);
  assert.equal(unrefed, false);
});
