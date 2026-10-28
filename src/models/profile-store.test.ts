import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EncryptedUserModelProfileStore } from "./profile-store.js";

test("stores provider credentials encrypted and isolates profiles by principal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-model-profile-test-"));
  const file = path.join(directory, "profiles.json");
  const secret = Buffer.alloc(32, 7).toString("base64");
  const store = new EncryptedUserModelProfileStore(file, secret);
  const apiKey = "provider-secret-key-123456";
  try {
    const metadata = await store.set("account-alice", {
      provider: "openai-compatible",
      model: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1/",
      apiKey,
    });
    assert.equal(metadata.model, "gpt-4.1-mini");
    assert.equal("apiKey" in metadata, false);
    assert.equal((await store.get("account-alice"))?.apiKey, apiKey);
    assert.equal(await store.get("account-bob"), undefined);
    const onDisk = await readFile(file, "utf8");
    assert.equal(onDisk.includes(apiKey), false);
    assert.equal(onDisk.includes("account-alice"), false);
    assert.equal(await store.delete("account-alice"), true);
    assert.equal(await store.get("account-alice"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("model profile rejects unapproved endpoints and insecure URLs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-model-profile-host-test-"));
  const store = new EncryptedUserModelProfileStore(path.join(directory, "profiles.json"), Buffer.alloc(32, 8).toString("base64"));
  try {
    await assert.rejects(() => store.set("alice", {
      provider: "openai-compatible", model: "model-a", apiKey: "provider-key-12345", baseUrl: "https://unapproved.example/v1/",
    }), /allowlisted hostname/i);
    await assert.rejects(() => store.set("alice", {
      provider: "openai-compatible", model: "model-a", apiKey: "provider-key-12345", baseUrl: "http://api.openai.com/v1/",
    }), /HTTPS/i);
    const profile = await store.set("alice", { provider: "gemini", model: "gemini-2.5-flash", apiKey: "gemini-secret-12345" });
    assert.equal(profile.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai/");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wrong encryption key fails closed instead of returning corrupt credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-model-profile-key-test-"));
  const file = path.join(directory, "profiles.json");
  const first = new EncryptedUserModelProfileStore(file, Buffer.alloc(32, 1).toString("base64"));
  const second = new EncryptedUserModelProfileStore(file, Buffer.alloc(32, 2).toString("base64"));
  try {
    await first.set("alice", { provider: "openrouter", model: "openrouter/auto", apiKey: "openrouter-secret-12345" });
    await assert.rejects(() => second.get("alice"), /could not be decrypted/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
