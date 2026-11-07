import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserProfileStore } from "./profile-store.js";

test("browser profiles are private to their owner and can be revoked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-browser-profiles-"));
  try {
    const store = new BrowserProfileStore(root);
    const profile = await store.create("principal-a");
    assert.equal((await store.get("principal-a", profile.id)).id, profile.id);
    await assert.rejects(store.get("principal-b", profile.id), /ownership|ENOENT/i);
    assert.equal((await store.list("principal-a")).length, 1);
    assert.equal((await store.list("principal-b")).length, 0);
    const directoryStat = await stat(profile.directory);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    await store.revoke("principal-a", profile.id);
    await assert.rejects(store.get("principal-a", profile.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser profile IDs cannot escape the owner directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-browser-profiles-"));
  try {
    const store = new BrowserProfileStore(root);
    await assert.rejects(store.get("principal-a", "../../outside"), /Invalid browser profile ID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser profile creation requires an owner identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-browser-profiles-"));
  try {
    const store = new BrowserProfileStore(root);
    await assert.rejects(store.create(" "), /valid browser profile owner/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
