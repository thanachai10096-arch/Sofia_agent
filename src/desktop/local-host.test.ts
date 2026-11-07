import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAllowlistedDesktopHostDriver, describeDesktopAction, parseDesktopApplicationAllowlist } from "./local-host.js";

test("local desktop allowlist accepts only existing absolute executable files", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-local-host-"));
  const executable = path.join(directory, "app");
  try {
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    const parsed = parseDesktopApplicationAllowlist(JSON.stringify({ editor: executable }));
    assert.equal(parsed.editor, executable);
    assert.throws(() => parseDesktopApplicationAllowlist(JSON.stringify({ editor: "relative/app" })), /absolute executable/);
    assert.throws(() => parseDesktopApplicationAllowlist(JSON.stringify({ editor: path.join(directory, "missing") })));
    assert.throws(() => parseDesktopApplicationAllowlist("[]"), /JSON object/);
    assert.throws(() => parseDesktopApplicationAllowlist("{"), /JSON object/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
