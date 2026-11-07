import test from "node:test";
import assert from "node:assert/strict";
import { DesktopCommandBroker } from "./remote-command-broker.js";

const action = { kind: "input.key" as const, key: "Enter" };

test("dispatch is delivered once and completed by the paired owner", async () => {
  const broker = new DesktopCommandBroker();
  const { token } = broker.connect("owner-a");
  const result = broker.dispatch("owner-a", action);
  const command = broker.poll(token);
  assert.ok(command);
  assert.deepEqual(command.action, action);
  assert.equal(broker.poll(token), null);
  assert.equal(broker.complete(token, command.id, { ok: true }), true);
  assert.deepEqual(await result, { ok: true });
  assert.equal(broker.complete(token, command.id, { ok: true }), false);
  broker.close();
});

test("a companion cannot claim or complete another owner's commands", async () => {
  const broker = new DesktopCommandBroker();
  const ownerA = broker.connect("owner-a");
  const ownerB = broker.connect("owner-b");
  const result = broker.dispatch("owner-a", action);
  assert.equal(broker.poll(ownerB.token), null);
  const command = broker.poll(ownerA.token);
  assert.ok(command);
  assert.equal(broker.complete(ownerB.token, command.id, { compromised: true }), false);
  assert.equal(broker.complete(ownerA.token, command.id, { ok: true }), true);
  await result;
  broker.close();
});

test("replacing a companion revokes its token and rejects in-flight work", async () => {
  const broker = new DesktopCommandBroker();
  const first = broker.connect("owner-a");
  const result = broker.dispatch("owner-a", action);
  const second = broker.connect("owner-a");
  await assert.rejects(result, /disconnected/);
  assert.throws(() => broker.poll(first.token), /not paired/);
  assert.equal(broker.poll(second.token), null);
  broker.close();
});

test("disconnect and broker shutdown fail pending commands closed", async () => {
  const broker = new DesktopCommandBroker();
  broker.connect("owner-a");
  const first = broker.dispatch("owner-a", action);
  broker.disconnect("owner-a");
  await assert.rejects(first, /disconnected/);
  broker.connect("owner-a");
  const second = broker.dispatch("owner-a", action);
  broker.close();
  await assert.rejects(second, /shut down/);
});

test("abort removes a queued command and a full queue rejects extra work", async () => {
  const broker = new DesktopCommandBroker({ maxPendingPerOwner: 1 });
  broker.connect("owner-a");
  const controller = new AbortController();
  const first = broker.dispatch("owner-a", action, { signal: controller.signal });
  await assert.rejects(broker.dispatch("owner-a", action), /queue is full/);
  controller.abort();
  await assert.rejects(first);
  broker.close();
});

test("dispatch rejects when no companion is paired", async () => {
  const broker = new DesktopCommandBroker();
  await assert.rejects(broker.dispatch("owner-a", action), /No paired desktop companion/);
  broker.close();
});

test("dispatch rejects malformed native actions before they enter the queue", async () => {
  const broker = new DesktopCommandBroker();
  broker.connect("owner-a");
  assert.throws(
    () => broker.dispatch("owner-a", { kind: "input.click", x: -1, y: 0, button: "left" } as never),
    /Invalid desktop click action/,
  );
  assert.throws(
    () => broker.dispatch("owner-a", { kind: "input.key", key: "Ctrl+Alt+Delete" } as never),
    /Invalid desktop key input action/,
  );
  assert.equal(broker.getStatus("owner-a").pendingCommands, 0);
  broker.close();
});

test("a saved local pairing survives ordinary desktop restarts within the idle retention window", () => {
  let now = 1_000_000;
  const broker = new DesktopCommandBroker({ now: () => now });
  const { token } = broker.connect("owner-a");
  now += 6 * 24 * 60 * 60 * 1_000;
  assert.equal(broker.getStatus("owner-a").connected, true);
  now += 2 * 24 * 60 * 60 * 1_000;
  assert.equal(broker.getStatus("owner-a").connected, false);
  assert.throws(() => broker.poll(token), /not paired/);
  broker.close();
});

test("durable pairing survives an API restart but pending commands are never replayed", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { FileDesktopCompanionStore } = await import("./companion-store.js");
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-broker-restart-"));
  try {
    const store = new FileDesktopCompanionStore(directory);
    const firstBroker = new DesktopCommandBroker({ store });
    const { token } = firstBroker.connect("owner-a");
    const interrupted = firstBroker.dispatch("owner-a", action);
    assert.ok(firstBroker.poll(token));
    firstBroker.close();
    await assert.rejects(interrupted, /shut down/);

    const restartedBroker = new DesktopCommandBroker({ store });
    assert.equal(restartedBroker.getStatus("owner-a").connected, true);
    assert.equal(restartedBroker.poll(token), null);
    const next = restartedBroker.dispatch("owner-a", action);
    const command = restartedBroker.poll(token);
    assert.ok(command);
    assert.equal(restartedBroker.complete(token, command.id, { afterRestart: true }), true);
    assert.deepEqual(await next, { afterRestart: true });
    restartedBroker.disconnect("owner-a");

    const afterRevoke = new DesktopCommandBroker({ store });
    assert.equal(afterRevoke.getStatus("owner-a").connected, false);
    assert.throws(() => afterRevoke.poll(token), /not paired/);
    afterRevoke.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable pairings remain isolated by owner across API restarts", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { FileDesktopCompanionStore } = await import("./companion-store.js");
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-broker-owner-"));
  try {
    const store = new FileDesktopCompanionStore(directory);
    const first = new DesktopCommandBroker({ store });
    const ownerA = first.connect("owner-a");
    const ownerB = first.connect("owner-b");
    first.close();
    const restarted = new DesktopCommandBroker({ store });
    const taskA = restarted.dispatch("owner-a", action);
    assert.equal(restarted.poll(ownerB.token), null);
    const claimedA = restarted.poll(ownerA.token);
    assert.ok(claimedA);
    assert.equal(restarted.complete(ownerB.token, claimedA.id, { wrongOwner: true }), false);
    assert.equal(restarted.complete(ownerA.token, claimedA.id, { ok: true }), true);
    await taskA;
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
