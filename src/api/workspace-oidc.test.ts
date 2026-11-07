import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateWorkspaceCsrf, WorkspaceOidc } from "./workspace-oidc.js";

const issuer = "https://identity.example.test";
const redirectUri = "https://sofia.example.test/auth/oidc/callback";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function makeToken(nonce: string, subject = "owner-subject"): string {
  const header = b64({ alg: "RS256", typ: "JWT", kid: "test-key" });
  const claims = b64({
    iss: issuer, sub: subject, aud: "sofia-client", nonce,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
  });
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
function setup(subject = "owner-subject") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-workspace-oidc-"));
  let nonce = "";
  let tokenBody = "";
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === issuer + "/.well-known/openid-configuration") {
      return new Response(JSON.stringify({
        issuer, authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks",
        response_types_supported: ["code"], id_token_signing_alg_values_supported: ["RS256"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === issuer + "/jwks") {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    }
    if (url === issuer + "/token") {
      tokenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ id_token: makeToken(nonce, subject) }), { status: 200 });
    }
    throw new Error("Unexpected OIDC URL: " + url);
  };
  const oidc = new WorkspaceOidc({
    issuer, clientId: "sofia-client", clientSecret: "test-secret",
    redirectUri, allowedSubject: "owner-subject",
    sessionDirectory: directory, fetcher,
  });
  return { oidc, directory, setNonce: (value: string) => { nonce = value; }, getTokenBody: () => tokenBody };
}

test("OIDC uses authorization code + PKCE, validates signed ID token and persists opaque sessions", async () => {
  const context = setup();
  try {
    const authorization = new URL(await context.oidc.begin());
    assert.equal(authorization.searchParams.get("response_type"), "code");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorization.searchParams.get("code_challenge"));
    assert.ok(authorization.searchParams.get("state"));
    context.setNonce(authorization.searchParams.get("nonce")!);
    const callback = redirectUri + "?code=authorization-code&state=" + authorization.searchParams.get("state");
    const created = await context.oidc.complete(callback);
    assert.equal(created.session.subject, "owner-subject");
    assert.ok(created.session.expiresAt > created.session.createdAt);
    assert.match(context.getTokenBody(), /code_verifier=/);
    assert.equal(context.oidc.getSession("sofia_workspace_session=" + created.token)?.subject, "owner-subject");
    assert.match(context.oidc.sessionCookie(created.token, 3600), /HttpOnly; Secure; SameSite=Lax/);
    context.oidc.logout("sofia_workspace_session=" + created.token);
    assert.equal(context.oidc.getSession("sofia_workspace_session=" + created.token), null);
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test("OIDC rejects callback origin mismatch, replayed state, and non-allowlisted subject", async () => {
  const context = setup("someone-else");
  try {
    const authorization = new URL(await context.oidc.begin());
    const state = authorization.searchParams.get("state")!;
    context.setNonce(authorization.searchParams.get("nonce")!);
    await assert.rejects(context.oidc.complete("https://evil.example.test/auth/oidc/callback?code=x&state=" + state));
    const callback = redirectUri + "?code=x&state=" + state;
    await assert.rejects(context.oidc.complete(callback), /not allowed/);
    await assert.rejects(context.oidc.complete(callback), /denied, expired, or invalid/);
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test("workspace CSRF check requires matching high-entropy cookie and header", () => {
  const token = "a".repeat(43);
  assert.equal(validateWorkspaceCsrf(token, token), true);
  assert.equal(validateWorkspaceCsrf(token, "b".repeat(43)), false);
  assert.equal(validateWorkspaceCsrf(undefined, token), false);
  assert.equal(validateWorkspaceCsrf("short", "short"), false);
});
