import assert from "node:assert/strict";
import test from "node:test";
import { LinuxQuotaWorkspaceProvisioner, parseLinuxQuotaHelperReply } from "./linux-quota-workspace-provisioner.js";

test("Linux quota provisioner rejects relative host paths", { skip: process.platform !== "linux" }, () => {
  assert.throws(() => new LinuxQuotaWorkspaceProvisioner({
    helperPath: "quota-helper",
    workspaceRoot: "/var/lib/sofia-runner",
    maxWorkspaceBytes: 512 * 1024 * 1024,
  }), /absolute paths/);
});

test("Linux quota provisioner rejects a quota too small for a runner workspace", { skip: process.platform !== "linux" }, () => {
  assert.throws(() => new LinuxQuotaWorkspaceProvisioner({
    helperPath: "/usr/local/libexec/sofia-quota-workspace",
    workspaceRoot: "/var/lib/sofia-runner",
    maxWorkspaceBytes: 1024,
  }), /at least 1 MiB/);
});

test("Linux quota provisioner validates helper execution limits", { skip: process.platform !== "linux" }, () => {
  assert.throws(() => new LinuxQuotaWorkspaceProvisioner({
    helperPath: "/usr/local/libexec/sofia-quota-workspace",
    workspaceRoot: "/var/lib/sofia-runner",
    maxWorkspaceBytes: 512 * 1024 * 1024,
    helperTimeoutMs: 0,
  }), /helperTimeoutMs/);
});

test("Linux quota helper parser accepts only the bounded success schema", () => {
  assert.deepEqual(
    parseLinuxQuotaHelperReply(JSON.stringify({
      ok: true,
      runId: "123e4567-e89b-42d3-a456-426614174000",
      workspacePath: "/var/lib/sofia-runner/run-1",
      quotaBytes: 536870912,
      quotaInodes: 20_000,
    })),
    {
      ok: true,
      runId: "123e4567-e89b-42d3-a456-426614174000",
      workspacePath: "/var/lib/sofia-runner/run-1",
      quotaBytes: 536870912,
      quotaInodes: 20_000,
    },
  );
});

test("Linux quota helper parser rejects unknown fields and malformed attestations", () => {
  assert.throws(() => parseLinuxQuotaHelperReply(JSON.stringify({
    ok: true,
    runId: "123e4567-e89b-42d3-a456-426614174000",
    workspacePath: "/var/lib/sofia-runner/run-1",
    quotaBytes: 536870912,
    quotaInodes: 20_000,
    diskQuotaEnforced: true,
  })), /unexpected or malformed/);
  assert.throws(() => parseLinuxQuotaHelperReply(JSON.stringify({
    ok: true,
    runId: "123e4567-e89b-42d3-a456-426614174000",
    quotaBytes: "unlimited",
  })), /unexpected or malformed/);
  assert.throws(() => parseLinuxQuotaHelperReply(JSON.stringify({ ok: false, runId: "run" })));
  assert.throws(() => parseLinuxQuotaHelperReply("not-json"));
});

test("Linux quota helper parser accepts a positive XFS project-quota readiness probe", () => {
  assert.deepEqual(parseLinuxQuotaHelperReply(JSON.stringify({
    ok: true,
    filesystemType: "xfs",
    projectQuotaEnabled: true,
  })), {
    ok: true,
    filesystemType: "xfs",
    projectQuotaEnabled: true,
  });
});

test("Linux quota helper parser rejects malformed readiness claims", () => {
  assert.throws(() => parseLinuxQuotaHelperReply(JSON.stringify({
    ok: true,
    filesystemType: "ext4",
    projectQuotaEnabled: true,
  })), /unexpected or malformed/);
  assert.throws(() => parseLinuxQuotaHelperReply(JSON.stringify({
    ok: true,
    filesystemType: "xfs",
    projectQuotaEnabled: "true",
  })), /unexpected or malformed/);
});
