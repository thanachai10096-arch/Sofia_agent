import test from "node:test";
import assert from "node:assert/strict";
import {
  assessHostedSetup,
  createHostedSetupConfig,
  validateSofiaApiBaseUrl,
} from "./wizard.js";

test("accepts HTTPS remote Sofia API URLs and normalizes trailing slashes", () => {
  assert.equal(
    validateSofiaApiBaseUrl(" https://sofia.example.com/v1/// "),
    "https://sofia.example.com/v1",
  );
});

test("allows HTTP only for loopback development URLs", () => {
  assert.equal(validateSofiaApiBaseUrl("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(validateSofiaApiBaseUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => validateSofiaApiBaseUrl("http://sofia.example.com"), /must use HTTPS/);
});

test("rejects invalid, credential-bearing, and query-bearing URLs", () => {
  assert.throws(() => validateSofiaApiBaseUrl(""), /Enter the Sofia API base URL/);
  assert.throws(() => validateSofiaApiBaseUrl("not a url"), /valid absolute URL/);
  assert.throws(() => validateSofiaApiBaseUrl("https://user:pass@sofia.example.com"), /Do not include/);
  assert.throws(() => validateSofiaApiBaseUrl("https://sofia.example.com?token=secret"), /query string/);
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
