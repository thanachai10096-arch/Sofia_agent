import assert from "node:assert/strict";
import test from "node:test";
import { LinuxQuotaWorkspaceProvisioner } from "./linux-quota-workspace-provisioner.js";

test("Linux quota provisioner rejects relative host paths", () => {
  assert.throws(() => new LinuxQuotaWorkspaceProvisioner({
    helperPath: "quota-helper",
    workspaceRoot: "/var/lib/sofia-runner",
    maxWorkspaceBytes: 512 * 1024 * 1024,
  }), /absolute paths/);
});

test("Linux quota provisioner rejects a quota too small for a runner workspace", () => {
  assert.throws(() => new LinuxQuotaWorkspaceProvisioner({
    helperPath: "/usr/local/libexec/sofia-quota-workspace",
    workspaceRoot: "/var/lib/sofia-runner",
    maxWorkspaceBytes: 1024,
  }), /at least 1 MiB/);
});

test("Linux quota provisioner validates helper execution limits", () => {
  assert.throws(() => new LinuxQuotaWorkspaceProvisioner({
    helperPath: "/usr/local/libexec/sofia-quota-workspace",
    workspaceRoot: "/var/lib/sofia-runner",
    maxWorkspaceBytes: 512 * 1024 * 1024,
    helperTimeoutMs: 0,
  }), /helperTimeoutMs/);
});
