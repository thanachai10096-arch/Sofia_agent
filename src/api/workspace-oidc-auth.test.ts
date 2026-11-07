import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { WorkspaceOidcAuth } from "./workspace-oidc-auth.js";

test("workspace OIDC uses state, nonce, PKCE and creates a single-operator secure session", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  let capturedVerifier = "";
  let capturedChallenge = "";
  let capturedState = "";
  let capturedNonce = "";
  const issuer = "https://identity.example.test";
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer, authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks",
      });
    }
    if (url === issuer + "/token") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      capturedVerifier = params.get("code_verifier") ?? "";
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({
        iss: issuer, sub: "operator-subject", aud: "sofia-client",
        exp: now + 300, iat: now, nonce: capturedNonce,
      })).toString("base64url");
      const payload = header + "." + claims;
      const signature = sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url");
      return Response.json({ id_token: payload + "." + signature });
    }
    if (url === issuer + "/jwks") return Response.json({ keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "RS256" }] });
    throw new Error("Unexpected OIDC request: " + url);
  };
  const auth = new WorkspaceOidcAuth({
    issuer, clientId: "sofia-client", clientSecret: "server-secret",
    redirectUri: "https://sofia.example.test/auth/callback",
    allowedSubject: "operator-subject", fetcher,
  });
  const login = await auth.beginLogin();
  const authorization = new URL(login.url);
  capturedState = authorization.searchParams.get("state") ?? "";
  capturedNonce = authorization.searchParams.get("nonce") ?? "";
  capturedChallenge = authorization.searchParams.get("code_challenge") ?? "";
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(capturedState, login.state);
  assert.ok(capturedNonce.length >= 32);
  const identity = await auth.completeLogin("authorization-code", capturedState);
  assert.equal(capturedChallenge, createHash("sha256").update(capturedVerifier).digest("base64url"));
  const cookie = auth.sessionCookie(identity.sessionId, 3600);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(auth.authenticate(cookie)?.subject, "operator-subject");
  auth.revoke(identity.sessionId);
  assert.equal(auth.authenticate(cookie), null);
  await assert.rejects(() => auth.completeLogin("authorization-code", capturedState));
});

test("workspace OIDC rejects an identity other than the configured operator", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const issuer = "https://identity.example.test";
  let nonce = "";
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({
      issuer, authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks",
    });
    if (url === issuer + "/token") {
      const now = Math.floor(Date.now() / 1000);
      const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url");
      const body = Buffer.from(JSON.stringify({ iss: issuer, sub: "someone-else", aud: "client", exp: now + 60, nonce })).toString("base64url");
      const payload = head + "." + body;
      return Response.json({ id_token: payload + "." + sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url") });
    }
    if (url === issuer + "/jwks") return Response.json({ keys: [{ ...jwk, kid: "k", use: "sig", alg: "RS256" }] });
    throw new Error("Unexpected request");
  };
  const auth = new WorkspaceOidcAuth({
    issuer, clientId: "client", clientSecret: "secret",
    redirectUri: "https://sofia.example.test/auth/callback",
    allowedSubject: "the-owner", fetcher,
  });
  const login = await auth.beginLogin();
  nonce = new URL(login.url).searchParams.get("nonce")!;
  await assert.rejects(() => auth.completeLogin("code", login.state), /not allowed/);
});
