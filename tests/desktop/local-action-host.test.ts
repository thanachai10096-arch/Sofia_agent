import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceRuntime } from "../../src/platform/runtime.js";
import type { DesktopAction, DesktopHostDriver } from "../../src/desktop/types.js";
import { startLocalDesktopActionHost } from "../../src/desktop/local-action-host.js";

test("paired local desktop host authenticates, scopes actions, and requires explicit approval", async (t) => {
  let code = "";
  let approved = true;
  let clickCount = 0;
  let captureCount = 0;
  const approvals: DesktopAction[] = [];
  const driver: DesktopHostDriver = {
    async captureScreen() {
      captureCount += 1;
      return { mimeType: "image/png", data: new Uint8Array([1, 2, 3]), width: 1, height: 1 };
    },
    async launchApplication(applicationId) { return { launched: true, applicationId }; },
    async click(point) { clickCount += 1; assert.deepEqual(point, { x: 12, y: 34, button: "left" }); },
    async typeText() {},
    async pressKey() {},
  };
  const host = await startLocalDesktopActionHost({
    allowedCapabilities: ["screen:capture", "input:control", "app:launch"],
    allowedOrigins: ["https://app.example"],
    driver,
    runtime: {} as WorkspaceRuntime,
    allowedApplications: ["editor"],
    requestApproval: async (action) => { approvals.push(action); return approved; },
    onPairingCode: (value) => { code = value; },
  });
  t.after(() => new Promise<void>((resolve) => host.close().then(resolve, resolve)));

  const origin = "https://app.example";
  const pair = await fetch(`${host.url}/pair`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code, capabilities: ["input:control"] }),
  });
  assert.equal(pair.status, 200);
  assert.equal(pair.headers.get("access-control-allow-origin"), origin);
  assert.equal(pair.headers.get("cache-control"), "no-store");
  const session = await pair.json() as { token: string; capabilities: string[] };
  assert.deepEqual(session.capabilities, ["input:control"]);

  const preflight = await fetch(`${host.url}/action`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);

  const click = await fetch(`${host.url}/action`, {
    method: "POST",
    headers: { origin, authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool: "desktop.input.click", input: { x: 12, y: 34, button: "left" } }),
  });
  assert.equal(click.status, 200);
  assert.equal(clickCount, 1);
  assert.deepEqual(approvals, [{ kind: "input.click", x: 12, y: 34, button: "left" }]);

  const noCapability = await fetch(`${host.url}/action`, {
    method: "POST",
    headers: { origin, authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool: "desktop.screen.capture", input: {} }),
  });
  assert.equal(noCapability.status, 400);
  assert.equal(captureCount, 0);

  approved = false;
  const denied = await fetch(`${host.url}/action`, {
    method: "POST",
    headers: { origin, authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool: "desktop.input.click", input: { x: 12, y: 34, button: "left" } }),
  });
  assert.equal(denied.status, 400);
  assert.equal(clickCount, 1, "a denied action must not reach the OS driver");

  const unauthenticated = await fetch(`${host.url}/action`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ tool: "desktop.input.click", input: { x: 12, y: 34 } }),
  });
  assert.equal(unauthenticated.status, 401);

  const hostileOrigin = await fetch(`${host.url}/action`, {
    method: "POST",
    headers: { origin: "https://evil.example", authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool: "desktop.input.click", input: { x: 12, y: 34 } }),
  });
  assert.equal(hostileOrigin.status, 403);
});

test("local desktop host rejects wildcard or non-origin CORS configuration", async () => {
  const driver: DesktopHostDriver = {
    async captureScreen() { return { mimeType: "image/png", data: new Uint8Array([1]), width: 1, height: 1 }; },
    async launchApplication(applicationId) { return { launched: true, applicationId }; },
    async click() {},
    async typeText() {},
    async pressKey() {},
  };
  await assert.rejects(
    startLocalDesktopActionHost({
      allowedCapabilities: [],
      allowedOrigins: ["*"],
      driver,
      runtime: {} as WorkspaceRuntime,
      requestApproval: async () => true,
      onPairingCode() {},
    }),
    /exact HTTP\(S\) origins/,
  );
});
