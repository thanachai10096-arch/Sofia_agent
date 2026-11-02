import test from "node:test";
import assert from "node:assert/strict";
import handler from "./health.js";

interface CapturedResponse {
  headers: Record<string, string>;
  statusCode: number;
  body?: unknown;
  setHeader(name: string, value: string): void;
  status(code: number): CapturedResponse;
  json(body: unknown): void;
}

function invoke(method: string): CapturedResponse {
  const response: CapturedResponse = {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; },
  };
  handler({ method }, response);
  return response;
}

test("Vercel health endpoint reports function reachability without claiming Core readiness", () => {
  const response = invoke("GET");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(response.body, {
    ok: true,
    service: "sofia-agent-vercel-smoke-test",
    deployment: "serverless-function-reachable",
    sofiaCore: "not_connected",
    durableStorage: "not_configured",
    durableExecution: "not_configured",
    productionReady: false,
  });
});

test("Vercel health endpoint rejects methods other than GET and HEAD", () => {
  const response = invoke("POST");
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "GET, HEAD");
  assert.deepEqual(response.body, { ok: false, error: "method_not_allowed" });
});
