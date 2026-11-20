import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
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

test("principal workspace resolver rejects a root directory accessible by group or others", async (t) => {
  if (process.platform === "win32") { t.skip("POSIX mode-bit permissions are unavailable on Windows."); return; }
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-root-mode-"));
  try {
    const root = path.join(temp, "workspaces");
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o755);
    const resolver = new PrincipalWorkspaceResolver(root);
    await assert.rejects(resolver.resolve("tenant:alice"), /group or other users/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("principal workspace resolver rejects a tenant directory accessible by group or others", async (t) => {
  if (process.platform === "win32") { t.skip("POSIX mode-bit permissions are unavailable on Windows."); return; }
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-tenant-mode-"));
  try {
    const root = path.join(temp, "workspaces");
    await mkdir(root, { mode: 0o700 });
    const opaque = createHash("sha256").update("tenant:alice", "utf8").digest("hex");
    const tenant = path.join(root, opaque);
    await mkdir(tenant, { mode: 0o700 });
    await chmod(tenant, 0o755);
    const resolver = new PrincipalWorkspaceResolver(root);
    await assert.rejects(resolver.resolve("tenant:alice"), /group or other users/i);
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
    const opaque = createHash("sha256").update("tenant:alice", "utf8").digest("hex");
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

test("principal IDs are normalized consistently before deriving workspace paths", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-normalize-"));
  try {
    const resolver = new PrincipalWorkspaceResolver(path.join(temp, "workspaces"));
    const plain = await resolver.resolve(" tenant:alice ");
    const normalized = await resolver.resolve("tenant:alice");
    assert.equal(plain, normalized);
    const composed = await resolver.resolve("tenant:caf\u00e9");
    const decomposed = await resolver.resolve("tenant:cafe\u0301");
    assert.equal(composed, decomposed);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("named mutable-state directories stay inside their principal workspace", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-stores-"));
  try {
    const resolver = new PrincipalWorkspaceResolver(path.join(temp, "workspaces"));
    const aliceMemory = await resolver.resolveStoreDirectory("tenant:alice", "memory");
    const aliceJobs = await resolver.resolveStoreDirectory("tenant:alice", "jobs");
    const bobMemory = await resolver.resolveStoreDirectory("tenant:bob", "memory");
    assert.notEqual(aliceMemory, aliceJobs);
    assert.notEqual(aliceMemory, bobMemory);
    assert.equal(path.basename(aliceMemory), "memory");
    assert.equal(path.basename(path.dirname(aliceMemory)), ".sofia");
    await assert.rejects(resolver.resolveStoreDirectory("tenant:alice", "../bob"), /store names/i);
    await assert.rejects(resolver.resolveStoreDirectory("tenant:alice", "/tmp/escape"), /store names/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("named mutable-state directory refuses an existing symlink", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-store-link-"));
  try {
    const root = path.join(temp, "workspaces");
    const outside = path.join(temp, "outside");
    await mkdir(outside);
    const resolver = new PrincipalWorkspaceResolver(root);
    const workspace = await resolver.resolve("tenant:alice");
    const stateRoot = path.join(workspace, ".sofia");
    await mkdir(stateRoot);
    try {
      await symlink(outside, path.join(stateRoot, "memory"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("Symlink creation is unavailable in this environment.");
        return;
      }
      throw error;
    }
    await assert.rejects(resolver.resolveStoreDirectory("tenant:alice", "memory"), /real directory|symbolic link/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("named mutable-state directories reject permissive permissions", async (t) => {
  if (process.platform === "win32") { t.skip("POSIX mode-bit permissions are unavailable on Windows."); return; }
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-store-mode-"));
  try {
    const root = path.join(temp, "workspaces");
    const resolver = new PrincipalWorkspaceResolver(root);
    const workspace = await resolver.resolve("tenant:alice");
    const stateRoot = path.join(workspace, ".sofia");
    await mkdir(stateRoot, { mode: 0o700 });
    const store = path.join(stateRoot, "memory");
    await mkdir(store, { mode: 0o700 });
    await chmod(store, 0o755);
    await assert.rejects(resolver.resolveStoreDirectory("tenant:alice", "memory"), /group or other users/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("named mutable-state directories reject a symlink state root", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-state-link-"));
  try {
    const root = path.join(temp, "workspaces");
    const outside = path.join(temp, "outside");
    await mkdir(outside);
    const resolver = new PrincipalWorkspaceResolver(root);
    const workspace = await resolver.resolve("tenant:alice");
    await symlink(outside, path.join(workspace, ".sofia"), "dir");
    await assert.rejects(resolver.resolveStoreDirectory("tenant:alice", "memory"), /real directory|symbolic link/i);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Symlink creation is unavailable in this environment.");
      return;
    }
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("named mutable-state directories reject a permissive .sofia parent", async (t) => {
  if (process.platform === "win32") { t.skip("POSIX mode-bit permissions are unavailable on Windows."); return; }
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-state-mode-"));
  try {
    const root = path.join(temp, "workspaces");
    const resolver = new PrincipalWorkspaceResolver(root);
    const workspace = await resolver.resolve("tenant:alice");
    const stateRoot = path.join(workspace, ".sofia");
    await mkdir(stateRoot, { mode: 0o700 });
    await chmod(stateRoot, 0o755);
    await assert.rejects(resolver.resolveStoreDirectory("tenant:alice", "memory"), /group or other users/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
