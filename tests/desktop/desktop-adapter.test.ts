import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopAdapterTools } from "../../src/desktop/adapter.js";
import { createDesktopPrincipal } from "../../src/desktop/runtime.js";
import type { DesktopAction, DesktopHostDriver } from "../../src/desktop/types.js";
import type { ToolContext } from "../../src/tools/types.js";

function context(signal?: AbortSignal): ToolContext { return { runtime: {} as ToolContext["runtime"], ...(signal ? { signal } : {}) }; }

function driver(calls: unknown[] = []): DesktopHostDriver {
  return {
    async captureScreen() { calls.push(["capture"]); return { mimeType: "image/png", data: new Uint8Array([1, 2, 3]), width: 100, height: 80 }; },
    async launchApplication(applicationId, args = []) { calls.push(["launch", applicationId, args]); return { launched: true, applicationId }; },
    async click(point) { calls.push(["click", point]); },
    async typeText(value) { calls.push(["type", value]); },
    async pressKey(key) { calls.push(["key", key]); },
  };
}

test("desktop screen capture requires its dedicated capability and bounds returned payloads", async () => {
  const tools = createDesktopAdapterTools({
    config: { driver: driver(), requestApproval: async () => true },
    principal: createDesktopPrincipal("screen-user", ["screen:capture"]),
  });
  const capture = tools.find((tool) => tool.name === "desktop.screen.capture");
  assert.ok(capture);
  const result = await capture.execute({}, context()) as { dataBase64: string; width: number; height: number };
  assert.equal(result.dataBase64, "AQID");
  assert.equal(result.width, 100);
  assert.equal(result.height, 80);

  const denied = createDesktopAdapterTools({
    config: { driver: driver(), requestApproval: async () => true },
    principal: createDesktopPrincipal("no-screen", []),
  }).find((tool) => tool.name === "desktop.screen.capture");
  assert.ok(denied);
  await assert.rejects(denied.execute({}, context()), /not permitted/);
});

test("desktop input actions require user approval before the native driver is called", async () => {
  const calls: unknown[] = [];
  const approvals: DesktopAction[] = [];
  const tools = createDesktopAdapterTools({
    config: { driver: driver(calls), requestApproval: async (action) => { approvals.push(action); return action.kind !== "input.click"; } },
    principal: createDesktopPrincipal("operator", ["input:control"]),
  });
  const click = tools.find((tool) => tool.name === "desktop.input.click");
  const type = tools.find((tool) => tool.name === "desktop.input.type_text");
  assert.ok(click);
  assert.ok(type);
  await assert.rejects(click.execute({ x: 10, y: 20 }, context()), /denied by the user/);
  assert.equal(calls.length, 0);
  await type.execute({ text: "hello" }, context());
  assert.deepEqual(approvals.map((action) => action.kind), ["input.click", "input.type"]);
  assert.deepEqual(approvals[1], { kind: "input.type", text: "hello" }, "approval must show the exact text that will be typed");
  assert.deepEqual(calls, [["type", "hello"]]);
});

test("desktop adapter rejects unapproved apps, invalid coordinates, and unsafe key names", async () => {
  const calls: unknown[] = [];
  const tools = createDesktopAdapterTools({
    config: { driver: driver(calls), requestApproval: async () => true, allowedApplications: ["calculator"] },
    principal: createDesktopPrincipal("operator", ["app:launch", "input:control"]),
  });
  const launch = tools.find((tool) => tool.name === "desktop.app.launch");
  const click = tools.find((tool) => tool.name === "desktop.input.click");
  const key = tools.find((tool) => tool.name === "desktop.input.press_key");
  assert.ok(launch);
  assert.ok(click);
  assert.ok(key);
  await assert.rejects(launch.execute({ applicationId: "terminal" }, context()), /not allowlisted/);
  await assert.rejects(click.execute({ x: -1, y: 4 }, context()), /coordinates/);
  await assert.rejects(key.execute({ key: "Ctrl+Alt+Delete" }, context()), /allowlist/);
  assert.deepEqual(calls, []);
});


test("desktop action cancels a pending approval and forwards the abort signal to the UI", async () => {
  const controller = new AbortController();
  const calls: unknown[] = [];
  let approvalSignal: AbortSignal | undefined;
  let markApprovalStarted!: () => void;
  const approvalStarted = new Promise<void>((resolve) => { markApprovalStarted = resolve; });
  const tools = createDesktopAdapterTools({
    config: {
      driver: driver(calls),
      requestApproval: async (_action, signal) => {
        approvalSignal = signal;
        markApprovalStarted();
        return new Promise<boolean>(() => {});
      },
    },
    principal: createDesktopPrincipal("operator", ["input:control"]),
  });
  const click = tools.find((tool) => tool.name === "desktop.input.click");
  assert.ok(click);
  const action = click.execute({ x: 1, y: 2 }, context(controller.signal));
  await approvalStarted;
  assert.equal(approvalSignal, controller.signal);
  controller.abort(new Error("approval timed out"));
  await assert.rejects(action, /approval timed out/);
  assert.deepEqual(calls, [], "aborted approval must not reach the native driver");
});
