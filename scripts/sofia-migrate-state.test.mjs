import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { applyMigration, buildMigrationPlan, inspectMigration } from "./sofia-migrate-state.mjs";

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "sofia-migration-test-"));
}

test("migration inventory finds legacy stores and dry-run does not modify them", async () => {
  const root = await temporaryDirectory();
  try {
    const workspace = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const tempDir = path.join(root, "old-temp");
    await mkdir(path.join(tempDir, "sofia-agents-runs"), { recursive: true });
    await writeFile(path.join(tempDir, "sofia-agents-runs", "run.json"), '{"run":1}');
    await mkdir(path.join(workspace, ".sofia"), { recursive: true });
    await writeFile(path.join(workspace, ".sofia", "api-usage.json"), '{"count":3}');

    const plan = buildMigrationPlan({ workspace, stateDir, tempDir, homeDir: root, platform: "linux", env: {} });
    const report = await inspectMigration(plan);
    assert.equal(report.reduce((sum, item) => sum + item.files, 0), 2);
    assert.equal(report.reduce((sum, item) => sum + item.bytes, 0), Buffer.byteLength('{"run":1}') + Buffer.byteLength('{"count":3}'));
    await assert.rejects(readFile(path.join(stateDir, "sofia-agents-runs", "run.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration copies files, verifies identical reruns, and retains sources", async () => {
  const root = await temporaryDirectory();
  try {
    const source = path.join(root, "old");
    const stateDir = path.join(root, "state");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "nested", "data.json"), '{"safe":true}');
    const plan = [{ source, target: path.join(stateDir, "sofia-agents-runs"), label: "test" }];
    const report = await inspectMigration(plan);
    const first = await applyMigration(report);
    assert.equal(first.results.filter(item => item.status === "copied").length, 1);
    assert.equal(await readFile(path.join(stateDir, "sofia-agents-runs", "nested", "data.json"), "utf8"), '{"safe":true}');
    assert.equal(await readFile(path.join(source, "nested", "data.json"), "utf8"), '{"safe":true}');
    const second = await applyMigration(await inspectMigration(plan));
    assert.equal(second.results.filter(item => item.status === "identical").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration never overwrites a conflicting destination", async () => {
  const root = await temporaryDirectory();
  try {
    const source = path.join(root, "old");
    const target = path.join(root, "state", "sofia-agents-jobs");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(source, "job.json"), '{"version":1}');
    await writeFile(path.join(target, "job.json"), '{"version":2}');
    const result = await applyMigration(await inspectMigration([{ source, target, label: "test" }]));
    assert.equal(result.conflicts.length, 1);
    assert.equal(await readFile(path.join(target, "job.json"), "utf8"), '{"version":2}');
    assert.equal(await readFile(path.join(source, "job.json"), "utf8"), '{"version":1}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration refuses symbolic links", async () => {
  const root = await temporaryDirectory();
  try {
    const source = path.join(root, "old");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(root, "outside.txt"), "outside");
    await symlink(path.join(root, "outside.txt"), path.join(source, "link.txt"));
    await assert.rejects(inspectMigration([{ source, target: path.join(root, "state"), label: "test" }]), /symbolic link/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
