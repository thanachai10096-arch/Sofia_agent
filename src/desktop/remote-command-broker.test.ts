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
