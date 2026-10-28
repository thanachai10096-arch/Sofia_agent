import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionStoreConfig } from "./config.js";

test("SQLite sessions can be explicitly enabled with the default persistent path", () => {
  assert.deepEqual(resolveSessionStoreConfig({ SOFIA_SESSION_STORE: "sqlite" }), { enabled: true });
});

test("legacy database path continues to enable SQLite sessions", () => {
  assert.deepEqual(
    resolveSessionStoreConfig({ SOFIA_SESSION_DB_PATH: "/var/lib/sofia/sessions.sqlite" }),
    { enabled: true, databasePath: "/var/lib/sofia/sessions.sqlite" },
  );
});

test("explicit SQLite mode accepts a custom database path", () => {
  assert.deepEqual(
    resolveSessionStoreConfig({
      SOFIA_SESSION_STORE: " SQLite ",
      SOFIA_SESSION_DB_PATH: "sessions/custom.sqlite",
    }),
    { enabled: true, databasePath: "sessions/custom.sqlite" },
  );
});

test("sessions remain disabled by default for backward compatibility", () => {
  assert.deepEqual(resolveSessionStoreConfig({}), { enabled: false });
});

test("explicit disabled mode is supported when no database path is set", () => {
  assert.deepEqual(resolveSessionStoreConfig({ SOFIA_SESSION_STORE: "disabled" }), { enabled: false });
});

test("invalid session store modes fail fast instead of silently disabling persistence", () => {
  assert.throws(
    () => resolveSessionStoreConfig({ SOFIA_SESSION_STORE: "sqllite" }),
    /SOFIA_SESSION_STORE must be either sqlite or disabled/,
  );
});

test("disabled mode cannot silently ignore a configured database path", () => {
  assert.throws(
    () => resolveSessionStoreConfig({
      SOFIA_SESSION_STORE: "disabled",
      SOFIA_SESSION_DB_PATH: "/var/lib/sofia/sessions.sqlite",
    }),
    /cannot be set when SOFIA_SESSION_STORE=disabled/,
  );
});
