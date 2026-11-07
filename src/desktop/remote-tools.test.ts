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
