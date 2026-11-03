import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteChatDelegationReplayStore } from "../src/api/sqlite-chat-delegation-replay-store.js";

const sqliteAvailable = await import("node:sqlite").then(() => true).catch(() => false);

function tempDatabase(): { directory: string; filePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-chat-replay-"));
  return { directory, filePath: path.join(directory, "replay.sqlite") };
}

const claim = {
  tenantId: "tenant-a",
  platform: "telegram" as const,
  nonce: "abcdefghijklmnopqrstuv",
  expiresAt: Date.now() + 60_000,
};

test("SQLite replay store persists nonce claims across reopen", { skip: !sqliteAvailable }, async () => {
  const temp = tempDatabase();
  let first: SqliteChatDelegationReplayStore | undefined;
  let reopened: SqliteChatDelegationReplayStore | undefined;
  try {
    first = await SqliteChatDelegationReplayStore.open(temp.filePath);
    assert.equal(await first.claim(claim), true);
    first.close();
    first = undefined;

    reopened = await SqliteChatDelegationReplayStore.open(temp.filePath);
    assert.equal(await reopened.claim(claim), false);
  } finally {
    first?.close();
    reopened?.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("SQLite replay store restores owner-only permissions before reopening", { skip: !sqliteAvailable || process.platform === "win32" }, async () => {
  const temp = tempDatabase();
  let store: SqliteChatDelegationReplayStore | undefined;
  try {
    store = await SqliteChatDelegationReplayStore.open(temp.filePath);
    store.close();
    store = undefined;

    fs.chmodSync(temp.directory, 0o755);
    fs.chmodSync(temp.filePath, 0o400);

    store = await SqliteChatDelegationReplayStore.open(temp.filePath);
    assert.equal(fs.statSync(temp.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(temp.filePath).mode & 0o777, 0o600);
    assert.equal(await store.claim({ ...claim, nonce: "zyxwvutsrqponmlkjihgfedc" }), true);
  } finally {
    store?.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("SQLite replay store does not allow a second connection to reclaim the same nonce", { skip: !sqliteAvailable }, async () => {
  const temp = tempDatabase();
  const first = await SqliteChatDelegationReplayStore.open(temp.filePath);
  const second = await SqliteChatDelegationReplayStore.open(temp.filePath);
  try {
    const results = await Promise.all([
      first.claim(claim),
      second.claim(claim),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  } finally {
    first.close();
    second.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("SQLite replay store allows only one claim across separate processes", { skip: !sqliteAvailable }, async () => {
  const temp = tempDatabase();
  const moduleUrl = new URL("../src/api/sqlite-chat-delegation-replay-store.js", import.meta.url).href;
  const childScript = `
    import { SqliteChatDelegationReplayStore } from ${JSON.stringify(moduleUrl)};
    const store = await SqliteChatDelegationReplayStore.open(process.argv[1]);
    try {
      const claimed = await store.claim(${JSON.stringify(claim)});
      process.stdout.write(JSON.stringify({ claimed }));
    } finally {
      store.close();
    }
  `;
  const runClaim = async (): Promise<boolean> => {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript, temp.filePath],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    });
    return (JSON.parse(stdout) as { claimed: boolean }).claimed;
  };

  try {
    const results = await Promise.all([runClaim(), runClaim()]);
    assert.equal(results.filter(Boolean).length, 1);
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("SQLite replay store isolates tenant and platform namespaces", { skip: !sqliteAvailable }, async () => {
  const temp = tempDatabase();
  const store = await SqliteChatDelegationReplayStore.open(temp.filePath);
  try {
    assert.equal(await store.claim(claim), true);
    assert.equal(await store.claim({ ...claim, tenantId: "tenant-b" }), true);
    assert.equal(await store.claim({ ...claim, platform: "discord" }), true);
    assert.equal(await store.claim(claim), false);
  } finally {
    store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("SQLite replay store rejects malformed claims", { skip: !sqliteAvailable }, async () => {
  const temp = tempDatabase();
  const store = await SqliteChatDelegationReplayStore.open(temp.filePath);
  try {
    await assert.rejects(
      store.claim({ ...claim, nonce: "bad nonce" }),
      /Invalid chat delegation replay claim/,
    );
  } finally {
    store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});
