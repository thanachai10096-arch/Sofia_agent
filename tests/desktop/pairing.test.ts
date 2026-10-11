import assert from "node:assert/strict";
import test from "node:test";
import { DesktopPairingAuthority } from "../../src/desktop/pairing.js";

test("pairing code is single-use and grants only explicitly requested allowed capabilities", () => {
  const authority = new DesktopPairingAuthority({
    allowedCapabilities: ["screen:capture", "input:control"],
    now: () => 1_000,
  });
  const { code } = authority.createPairingCode();
  const session = authority.pair(code, ["screen:capture"]);
  assert.equal(session.principal.capabilities.has("screen:capture"), true);
  assert.equal(session.principal.capabilities.has("input:control"), false);
  assert.equal(authority.authenticate(session.token).id, session.principal.id);
  assert.throws(() => authority.pair(code, ["screen:capture"]), /missing or expired|Invalid pairing code/);
});

test("pairing refuses unapproved capabilities without consuming a valid code", () => {
  const authority = new DesktopPairingAuthority({ allowedCapabilities: ["screen:capture"] });
  const { code } = authority.createPairingCode();
  assert.throws(() => authority.pair(code, ["input:control"]), /not allowed by the local operator/);
  assert.doesNotThrow(() => authority.pair(code, ["screen:capture"]));
});

test("pairing code and session expire, and tokens can be revoked", () => {
  let now = 10_000;
  const authority = new DesktopPairingAuthority({
    allowedCapabilities: ["workspace:read"],
    pairingCodeTtlMs: 30_000,
    accessTokenTtlMs: 60_000,
    now: () => now,
  });
  const pending = authority.createPairingCode();
  now = pending.expiresAt;
  assert.throws(() => authority.pair(pending.code), /missing or expired/);

  const next = authority.createPairingCode();
  const session = authority.pair(next.code, ["workspace:read"]);
  assert.equal(authority.revoke(session.token), true);
  assert.throws(() => authority.authenticate(session.token), /Invalid or expired/);

  const third = authority.createPairingCode();
  const expiringSession = authority.pair(third.code, ["workspace:read"]);
  now += 60_000;
  assert.throws(() => authority.authenticate(expiringSession.token), /Invalid or expired/);
});

test("invalid pairing codes do not reveal token data and revokeAll clears sessions", () => {
  const authority = new DesktopPairingAuthority({ allowedCapabilities: ["workspace:list"] });
  const { code } = authority.createPairingCode();
  assert.throws(() => authority.pair("not-a-code"), /Invalid pairing code/);
  const session = authority.pair(code, ["workspace:list"]);
  authority.revokeAll();
  assert.throws(() => authority.authenticate(session.token), /Invalid or expired/);
});

test("pairing code is invalidated after repeated incorrect attempts", () => {
  const authority = new DesktopPairingAuthority({
    allowedCapabilities: ["screen:capture"],
    maxPairingAttempts: 2,
  });
  const { code } = authority.createPairingCode();
  assert.throws(() => authority.pair(code === "000000" ? "000001" : "000000"), /Invalid pairing code/);
  assert.throws(() => authority.pair(code === "000000" ? "000001" : "000000"), /Invalid pairing code/);
  assert.throws(() => authority.pair(code), /missing or expired/);
});


test("loopback pairing host rejects cross-port origins and returns only scoped sessions", async () => {
  const { startLocalPairingHost } = await import("../../src/desktop/local-pairing-host.js");
  let pairingCode = "";
  const host = await startLocalPairingHost({
    allowedCapabilities: ["screen:capture"],
    onPairingCode: (code) => { pairingCode = code; },
  });
  try {
    const port = new URL(host.url).port;
    const body = JSON.stringify({ code: pairingCode, capabilities: ["screen:capture"] });
    const rejected = await fetch(`${host.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:12345" },
      body,
    });
    assert.equal(rejected.status, 403);

    const accepted = await fetch(`${host.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body,
    });
    assert.equal(accepted.status, 200);
    const result = await accepted.json() as { token?: string; capabilities?: string[] };
    assert.equal(typeof result.token, "string");
    assert.deepEqual(result.capabilities, ["screen:capture"]);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
  } finally {
    await host.close();
  }
});
