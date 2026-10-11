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
