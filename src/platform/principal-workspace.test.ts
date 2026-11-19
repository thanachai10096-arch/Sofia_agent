import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { PrincipalWorkspaceResolver } from "./principal-workspace.js";

test("principal workspaces are stable and isolated by opaque principal hashes", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-workspaces-"));
  try {
    const resolver = new PrincipalWorkspaceResolver(path.join(temp, "workspaces"));
    const alice = await resolver.resolve("tenant:alice");
    const bob = await resolver.resolve("tenant:bob");
    assert.equal(alice, await resolver.resolve("tenant:alice"));
    assert.notEqual(alice, bob);
    assert.equal(path.dirname(alice), await realpath(path.join(temp, "workspaces")));
    assert.equal(path.basename(alice).length, 64);
    assert.equal(path.basename(alice).includes("alice"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("principal workspace resolver rejects invalid principal identifiers", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-invalid-"));
  try {
    const resolver = new PrincipalWorkspaceResolver(path.join(temp, "workspaces"));
    await assert.rejects(resolver.resolve(""), /principal ID/i);
    await assert.rejects(resolver.resolve("bad\u0000id"), /principal ID/i);
    await assert.rejects(resolver.resolve("x".repeat(513)), /principal ID/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("principal workspace resolver refuses a symlink at the tenant directory", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-symlink-"));
  try {
    const root = path.join(temp, "workspaces");
    const outside = path.join(temp, "outside");
    await mkdir(root);
    await mkdir(outside);
    const resolver = new PrincipalWorkspaceResolver(root);
    const opaque = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update("tenant:alice", "utf8").digest("hex"));
    try {
      await symlink(outside, path.join(root, opaque), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("Symlink creation is unavailable in this environment.");
        return;
      }
      throw error;
    }
    await assert.rejects(resolver.resolve("tenant:alice"), /real directory|symbolic link/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("principal workspace resolver rejects a symlink root", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-root-link-"));
  try {
    const actual = path.join(temp, "actual");
    const linked = path.join(temp, "linked");
    await mkdir(actual);
    try {
      await symlink(actual, linked, "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("Symlink creation is unavailable in this environment.");
        return;
      }
      throw error;
    }
    const resolver = new PrincipalWorkspaceResolver(linked);
    await assert.rejects(resolver.resolve("tenant:alice"), /real directory|symbolic link/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
