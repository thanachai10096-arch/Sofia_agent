import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopRelayNonce,
  DesktopRelayReplayGuard,
  signDesktopRelayRequest,
  verifyDesktopRelayRequest,
} from "../../src/desktop/relay-protocol.js";

const secret = Buffer.alloc(32, 7);
const deviceId = "desktop-device-0001";

function request(now = 1_800_000_000_000) {
  return {
    deviceId,
    method: "POST",
    path: "/v1/desktop-relay/commands/claim?wait=20",
    timestamp: now,
    nonce: createDesktopRelayNonce(),
    body: JSON.stringify({ action: "desktop.screen.capture" }),
  };
}

test("relay request signatures authenticate method, path, timestamp, nonce and exact body", () => {
  const value = request();
  const headers = signDesktopRelayRequest(value, secret);
  const guard = new DesktopRelayReplayGuard({ now: () => value.timestamp });
  assert.equal(verifyDesktopRelayRequest(value, headers, secret, guard, { now: () => value.timestamp }), true);
  assert.equal(verifyDesktopRelayRequest({ ...value, body: "{}" }, headers, secret, new DesktopRelayReplayGuard({ now: () => value.timestamp }), { now: () => value.timestamp }), false);
  assert.equal(verifyDesktopRelayRequest({ ...value, path: "/v1/desktop-relay/commands/other" }, headers, secret, new DesktopRelayReplayGuard({ now: () => value.timestamp }), { now: () => value.timestamp }), false);
});

test("relay replay guard rejects a nonce after first successful verification", () => {
  const value = request();
  const headers = signDesktopRelayRequest(value, secret);
  const guard = new DesktopRelayReplayGuard({ now: () => value.timestamp });
  const options = { now: () => value.timestamp };
  assert.equal(verifyDesktopRelayRequest(value, headers, secret, guard, options), true);
  assert.equal(verifyDesktopRelayRequest(value, headers, secret, guard, options), false);
});

test("relay authentication rejects stale timestamps, mismatched identity and malformed credentials", () => {
  const value = request();
  const headers = signDesktopRelayRequest(value, secret);
  assert.equal(verifyDesktopRelayRequest(value, headers, secret, new DesktopRelayReplayGuard(), { now: () => value.timestamp + 301_000 }), false);
  assert.equal(verifyDesktopRelayRequest(value, { ...headers, "x-sofia-device-id": "desktop-device-9999" }, secret, new DesktopRelayReplayGuard({ now: () => value.timestamp }), { now: () => value.timestamp }), false);
  assert.throws(() => signDesktopRelayRequest(value, Buffer.alloc(16)), /at least 32 bytes/);
});

test("replay guard expires old nonces and fails closed at capacity", () => {
  let now = 10_000;
  const guard = new DesktopRelayReplayGuard({ now: () => now, maxEntries: 100 });
  assert.equal(guard.consume(deviceId, "nonce-abcdefghijkl", 10_500), true);
  assert.equal(guard.consume(deviceId, "nonce-abcdefghijkl", 10_500), false);
  now = 10_501;
  assert.equal(guard.consume(deviceId, "nonce-abcdefghijkl", 11_000), true);

  const full = new DesktopRelayReplayGuard({ now: () => now, maxEntries: 100 });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(full.consume(deviceId, `nonce-${String(index).padStart(16, "0")}`, 20_000), true);
  }
  assert.equal(full.consume(deviceId, "nonce-one-more-entry", 20_000), false);
});
