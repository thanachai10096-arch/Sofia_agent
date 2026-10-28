import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

test("offline Brain-loop benchmark completes a verified task through TokenAwareGateway", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "bench/brain-loop-efficiency.mjs"], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.benchmark, "offline-sofia-brain-loop");
  assert.equal(report.mode, "deterministic synthetic model route; no network or provider calls");
  assert.equal(report.completed, true);
  assert.equal(report.state, "completed");
  assert.equal(report.verifiedCriteria, 1);
  assert.equal(report.acceptanceCriteria, 1);
  assert.equal(report.efficiency.completed, true);
  assert.equal(report.efficiency.usageComplete, true);
  assert.equal(report.efficiency.unmeasuredModelCalls, 0);
  assert.equal(report.gatewayCalls.length, 2);
  assert.ok(report.gatewayCalls.some((call) => call.evidenceCount > 0), "caller context should reach the gateway on the understanding phase");
  assert.match(report.caveat, /not provider-billed usage or real-world savings/);
});
