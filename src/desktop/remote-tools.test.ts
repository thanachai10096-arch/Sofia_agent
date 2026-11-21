import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteDesktopTools } from "./remote-tools.js";
import { DesktopCommandBroker } from "./remote-command-broker.js";
import { assertToolAllowed, classifyToolEffects, defaultPolicy } from "../security/policy.js";

test("remote desktop Brain tools dispatch only the granted capabilities", async () => {
  const broker = new DesktopCommandBroker();
  const { token } = broker.connect("owner-a");
  const tools = createRemoteDesktopTools({ broker, ownerKeyId: "owner-a", capabilities: ["input:control"] });
  assert.deepEqual(tools.map((tool) => tool.name), [
    "desktop.remote.input.click",
    "desktop.remote.input.type_text",
    "desktop.remote.input.press_key",
  ]);
  const click = tools[0]!;
  const pending = click.execute({ x: 10, y: 20, button: "left" }, { runtime: {} as never });
  const command = broker.poll(token);
  assert.ok(command);
  assert.deepEqual(command.action, { kind: "input.click", x: 10, y: 20, button: "left" });
  assert.equal(broker.complete(token, command.id, { ok: true }), true);
  assert.deepEqual(await pending, { ok: true });
  broker.close();
});

test("remote desktop tools are absent without explicit capability grants", () => {
  const broker = new DesktopCommandBroker();
  assert.deepEqual(createRemoteDesktopTools({ broker, ownerKeyId: "owner-a", capabilities: [] }), []);
  broker.close();
});

test("remote desktop actions have a dedicated fail-closed policy gate", () => {
  assert.deepEqual(classifyToolEffects("desktop.remote.input.click"), ["desktop"]);
  assert.throws(
    () => assertToolAllowed({ ...defaultPolicy, allowRemoteDesktop: false }, "desktop.remote.input.click", ["desktop"]),
    /disabled by policy/,
  );
  assert.doesNotThrow(() =>
    assertToolAllowed({ ...defaultPolicy, allowRemoteDesktop: true }, "desktop.remote.input.click", ["desktop"]),
  );
});

test("remote screen capture is exposed only with its dedicated capability and dispatched for local approval", async () => {
  const broker = new DesktopCommandBroker();
  const { token } = broker.connect("screen-owner");
  const tools = createRemoteDesktopTools({ broker, ownerKeyId: "screen-owner", capabilities: ["screen:capture"] });
  assert.deepEqual(tools.map((tool) => tool.name), ["desktop.remote.screen.capture"]);
  const pending = tools[0]!.execute({}, { runtime: {} as never });
  const command = broker.poll(token);
  assert.ok(command);
  assert.deepEqual(command.action, { kind: "screen.capture" });
  const image = { mimeType: "image/png", dataBase64: "cG5n", width: 2, height: 1 };
  assert.equal(broker.complete(token, command.id, image), true);
  assert.deepEqual(await pending, image);
  broker.close();
});

test("screen capture is not exposed by the remote desktop tools without explicit scope", () => {
  const broker = new DesktopCommandBroker();
  assert.deepEqual(createRemoteDesktopTools({
    broker, ownerKeyId: "screen-owner", capabilities: ["app:launch"],
  }).map((tool) => tool.name), ["desktop.remote.app.launch"]);
  broker.close();
});
