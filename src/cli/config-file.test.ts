import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeSafeLocalConfig } from "./config-file.js";

test("local config stores only non-secret metadata with private permissions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-config-test-"));
  const configDir = path.join(directory, ".sofia");
  const file = path.join(configDir, "config.json");
  try {
    await writeSafeLocalConfig(file, {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "must-not-be-written",
    } as { provider: string; baseUrl: string; model: string });
    const saved = await readFile(file, "utf8");
    assert.equal(saved.includes("must-not-be-written"), false);
    assert.deepEqual(JSON.parse(saved), {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    });
    assert.equal((await lstat(configDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config persistence replaces a symlink without modifying its target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-config-symlink-test-"));
  const configDir = path.join(directory, ".sofia");
  const file = path.join(configDir, "config.json");
  const target = path.join(directory, "outside.json");
  try {
    await mkdir(configDir, { mode: 0o700 });
    await writeFile(target, "keep this external file unchanged", { mode: 0o600 });
    await symlink(target, file);
    await writeSafeLocalConfig(file, {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
    });
    assert.equal(await readFile(target, "utf8"), "keep this external file unchanged");
    assert.equal((await readFile(file, "utf8")).includes("ollama"), true);
    assert.equal((await lstat(file)).isSymbolicLink(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config persistence refuses a symlinked config directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-config-dir-symlink-test-"));
  const realDirectory = path.join(directory, "real");
  const linkedDirectory = path.join(directory, ".sofia");
  try {
    await mkdir(realDirectory, { mode: 0o700 });
    await symlink(realDirectory, linkedDirectory, "dir");
    await assert.rejects(
      writeSafeLocalConfig(path.join(linkedDirectory, "config.json"), {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.2",
      }),
      /must be a real directory/i,
    );
    assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(realDirectory)), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
