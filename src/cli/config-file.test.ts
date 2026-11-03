import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applySafeLocalConfigEnvironment, assertNoLegacyPlaintextApiKey, writeSafeLocalConfig } from "./config-file.js";
import { resolveCliInvocation } from "./commands.js";

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

test("setup refuses to overwrite a legacy plaintext key and preserves it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-legacy-key-test-"));
  const file = path.join(directory, "config.json");
  const original = JSON.stringify({ provider: "openai", apiKey: "legacy-secret-value" });
  try {
    await writeFile(file, original, { mode: 0o600 });
    await assert.rejects(assertNoLegacyPlaintextApiKey(file, "OPENAI_API_KEY"), /OPENAI_API_KEY.*left unchanged/);
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup refuses malformed existing config instead of replacing potentially recoverable data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-malformed-config-test-"));
  const file = path.join(directory, "config.json");
  const original = '{"apiKey":"possibly recoverable secret"';
  try {
    await writeFile(file, original, { mode: 0o600 });
    await assert.rejects(assertNoLegacyPlaintextApiKey(file, "SOFIA_MODEL_API_KEY"), /not valid JSON.*refusing to overwrite/);
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup refuses symlinked config and does not inspect an external target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-config-symlink-test-"));
  const file = path.join(directory, "config.json");
  const target = path.join(directory, "outside.json");
  try {
    await writeFile(target, JSON.stringify({ apiKey: "external-secret" }), { mode: 0o600 });
    await symlink(target, file);
    await assert.rejects(assertNoLegacyPlaintextApiKey(file, "SOFIA_MODEL_API_KEY"), /regular file, not a symbolic link/);
    assert.equal((await lstat(file)).isSymbolicLink(), true);
    assert.equal((await readFile(target, "utf8")).includes("external-secret"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config persistence replaces a symlink without modifying its target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-config-symlink-write-test-"));
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
    assert.deepEqual(await readdir(realDirectory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy apiKey fields are never copied into the process environment", () => {
  const environment: NodeJS.ProcessEnv = {};
  const legacyConfig = {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKey: "legacy-plaintext-secret",
  };
  applySafeLocalConfigEnvironment(legacyConfig, environment);
  assert.equal(environment.SOFIA_MODEL_PROVIDER, "openai");
  assert.equal(environment.SOFIA_MODEL_BASE_URL, "https://api.openai.com/v1");
  assert.equal(environment.SOFIA_MODEL_NAME, "gpt-4.1-mini");
  assert.equal(environment.SOFIA_MODEL_API_KEY, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
});

test("explicit environment settings take precedence over local metadata", () => {
  const environment: NodeJS.ProcessEnv = {
    SOFIA_MODEL_PROVIDER: "custom-provider",
    SOFIA_MODEL_BASE_URL: "https://custom.example/v1",
    SOFIA_MODEL_NAME: "custom-model",
    SOFIA_MODEL_API_KEY: "environment-secret",
  };
  applySafeLocalConfigEnvironment({
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  }, environment);
  assert.equal(environment.SOFIA_MODEL_PROVIDER, "custom-provider");
  assert.equal(environment.SOFIA_MODEL_BASE_URL, "https://custom.example/v1");
  assert.equal(environment.SOFIA_MODEL_NAME, "custom-model");
  assert.equal(environment.SOFIA_MODEL_API_KEY, "environment-secret");
});

test("empty local metadata does not erase existing environment configuration", () => {
  const environment: NodeJS.ProcessEnv = {
    SOFIA_MODEL_PROVIDER: "openrouter",
    SOFIA_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
    SOFIA_MODEL_NAME: "provider/model",
  };
  applySafeLocalConfigEnvironment({ provider: "", baseUrl: "", model: "" }, environment);
  assert.equal(environment.SOFIA_MODEL_PROVIDER, "openrouter");
  assert.equal(environment.SOFIA_MODEL_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(environment.SOFIA_MODEL_NAME, "provider/model");
});


test("CLI argv resolves help and supported commands without side effects", () => {
  assert.deepEqual(resolveCliInvocation([]), { command: "help" });
  assert.deepEqual(resolveCliInvocation(["--help"]), { command: "help" });
  for (const command of ["setup", "chat", "init", "status"] as const) {
    assert.deepEqual(resolveCliInvocation([command]), { command });
  }
});

test("CLI run combines task arguments and unknown commands resolve to help", () => {
  assert.deepEqual(resolveCliInvocation(["run", "inspect", "workspace"]), {
    command: "run",
    task: "inspect workspace",
  });
  assert.deepEqual(resolveCliInvocation(["unsupported"]), { command: "help" });
});

test("safe config loading returns only non-secret provider metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-safe-load-test-"));
  const file = path.join(directory, "config.json");
  try {
    await writeFile(file, JSON.stringify({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    }));
    assert.deepEqual(await readSafeLocalConfig(file), {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe config loading rejects legacy plaintext keys instead of importing them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-safe-legacy-test-"));
  const file = path.join(directory, "config.json");
  const original = JSON.stringify({ provider: "openai", apiKey: "legacy-secret-value" });
  try {
    await writeFile(file, original, { mode: 0o600 });
    await assert.rejects(readSafeLocalConfig(file), /legacy plaintext API key/);
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe config loading rejects non-object and invalid-typed settings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-cli-invalid-load-test-"));
  const file = path.join(directory, "config.json");
  try {
    await writeFile(file, JSON.stringify(["not", "an", "object"]));
    await assert.rejects(readSafeLocalConfig(file), /must contain a JSON object/);
    await writeFile(file, JSON.stringify({ provider: 42 }));
    await assert.rejects(readSafeLocalConfig(file), /provider must be a string/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
