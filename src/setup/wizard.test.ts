import test from "node:test";
import assert from "node:assert/strict";
import {
  assessHostedSetup,
  checkHostedSofiaApi,
  createHostedSetupConfig,
  validateSofiaApiBaseUrl,
} from "./wizard.js";

test("accepts HTTPS API origins and normalizes trailing slashes", () => {
  assert.equal(
    validateSofiaApiBaseUrl(" https://sofia.example.com/// "),
    "https://sofia.example.com",
  );
});

test("allows HTTP only for loopback development URLs", () => {
  assert.equal(validateSofiaApiBaseUrl("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(validateSofiaApiBaseUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => validateSofiaApiBaseUrl("http://sofia.example.com"), /must use HTTPS/);
});

test("rejects invalid, credential-bearing, query-bearing, and path-prefixed URLs", () => {
  assert.throws(() => validateSofiaApiBaseUrl(""), /Enter the Sofia API base URL/);
  assert.throws(() => validateSofiaApiBaseUrl("not a url"), /valid absolute URL/);
  assert.throws(() => validateSofiaApiBaseUrl("https://user:pass@sofia.example.com"), /Do not include/);
  assert.throws(() => validateSofiaApiBaseUrl("https://sofia.example.com?token=secret"), /query string/);
  assert.throws(() => validateSofiaApiBaseUrl("https://sofia.example.com/v1"), /without a path prefix/);
  assert.throws(() => validateSofiaApiBaseUrl("file:///tmp/sofia"), /must use HTTPS/);
});

test("setup config persists only non-secret connection metadata", () => {
  assert.deepEqual(createHostedSetupConfig("https://sofia.example.com/"), {
    version: 1,
    mode: "hosted",
    apiBaseUrl: "https://sofia.example.com",
  });
});

test("readiness does not claim a live connection without a check", () => {
  const result = assessHostedSetup({
    apiBaseUrl: "https://sofia.example.com",
    hasApiKey: true,
  });
  assert.equal(result.readyToTry, true);
  assert.equal(result.steps.find((step) => step.id === "verification")?.status, "not_tested");
  assert.match(result.steps.find((step) => step.id === "verification")?.description ?? "", /Not tested/);
});

test("missing API key requires attention and is never stored", () => {
  const result = assessHostedSetup({
    apiBaseUrl: "https://sofia.example.com",
    hasApiKey: false,
  });
  assert.equal(result.readyToTry, false);
  assert.equal(result.steps.find((step) => step.id === "credentials")?.status, "needs_attention");
  assert.ok(!JSON.stringify(createHostedSetupConfig("https://sofia.example.com")).includes("API_KEY"));
});

test("explicit API check verifies health and authenticated usage without running a task", async () => {
  const calls: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
  const result = await checkHostedSofiaApi({
    apiBaseUrl: "https://sofia.example.com",
    apiKey: "test-key",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
        redirect: init?.redirect,
      });
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, service: "sofia-agent-api" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ used: 0 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.reachable, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.service, "sofia-agent-api");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://sofia.example.com/health",
    "https://sofia.example.com/v1/usage",
  ]);
  assert.equal(calls[0]?.authorization, undefined);
  assert.equal(calls[1]?.authorization, "Bearer test-key");
  assert.equal(calls[0]?.redirect, "error");
  assert.equal(calls[1]?.redirect, "error");
});

test("explicit API check reports rejected credentials without exposing the key", async () => {
  const result = await checkHostedSofiaApi({
    apiBaseUrl: "https://sofia.example.com",
    apiKey: "secret-test-key",
    fetchImpl: async (input) => String(input).endsWith("/health")
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  });
  assert.equal(result.reachable, true);
  assert.equal(result.authenticated, false);
  assert.match(result.message, /HTTP 401/);
  assert.ok(!result.message.includes("secret-test-key"));
});

test("explicit API check reports health reachability without a key and never sends an empty bearer token", async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const result = await checkHostedSofiaApi({
    apiBaseUrl: "https://sofia.example.com",
    apiKey: " ",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return new Response(JSON.stringify({ ok: true, service: "sofia-agent-api" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.reachable, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.service, "sofia-agent-api");
  assert.match(result.message, /SOFIA_API_KEY/);
  assert.deepEqual(calls, [{
    url: "https://sofia.example.com/health",
    authorization: undefined,
  }]);
});
