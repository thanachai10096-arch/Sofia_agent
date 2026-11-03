import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SafeLocalConfig {
  provider: string;
  baseUrl: string;
  model: string;
}

/**
 * Refuse setup writes when an older config still contains a plaintext key.
 * The key is deliberately not migrated or deleted: the user must first move
 * it to the provider's environment variable so setup cannot destroy the only
 * copy of a credential.
 */
export async function assertNoLegacyPlaintextApiKey(filePath: string, environmentVariable: string): Promise<void> {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("Sofia config must be a regular file, not a symbolic link.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("Existing Sofia config is not valid JSON; refusing to overwrite it. Back it up and repair it before rerunning setup.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Existing Sofia config must contain a JSON object; refusing to overwrite it.");
  }
  const apiKey = (parsed as { apiKey?: unknown }).apiKey;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    throw new Error(
      `An older plaintext API key exists in ~/.sofia/config.json. Move it to the ${environmentVariable} environment variable, verify Sofia can read it, then securely remove the old apiKey field before rerunning setup. The existing config was left unchanged.`,
    );
  }
}


/**
 * Read only non-secret CLI settings. Legacy plaintext credentials are never
 * imported into process.env; users must migrate them to environment variables.
 */
export async function readSafeLocalConfig(filePath: string): Promise<Partial<SafeLocalConfig>> {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("Sofia config must be a regular file, not a symbolic link.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("Existing Sofia config is not valid JSON; refusing to load it.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Existing Sofia config must contain a JSON object.");
  }
  const config = parsed as Record<string, unknown>;
  if (typeof config.apiKey === "string" && config.apiKey.length > 0) {
    throw new Error("A legacy plaintext API key exists in ~/.sofia/config.json. Move it to the matching environment variable, then securely remove the apiKey field before running Sofia.");
  }
  for (const field of ["provider", "baseUrl", "model"] as const) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      throw new Error(`Invalid Sofia config: ${field} must be a string.`);
    }
  }
  return {
    ...(typeof config.provider === "string" ? { provider: config.provider } : {}),
    ...(typeof config.baseUrl === "string" ? { baseUrl: config.baseUrl } : {}),
    ...(typeof config.model === "string" ? { model: config.model } : {}),
  };
}

/**
 * Atomically persist only non-secret provider metadata. The destination is
 * replaced by rename, so a pre-existing symlink is never followed.
 */
export async function writeSafeLocalConfig(filePath: string, config: SafeLocalConfig): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Sofia config directory must be a real directory, not a symbolic link.");
  }
  await chmod(directory, 0o700);

  const safeConfig: SafeLocalConfig = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
  };
  const temporaryPath = path.join(directory, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(safeConfig, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Apply a local provider profile only when the environment has not selected a
 * different provider. Provider, endpoint, and model are one configuration unit:
 * mixing an environment-selected provider with a stale local endpoint can send
 * credentials to the wrong origin or make a valid setup fail closed.
 */
export function applySafeLocalConfigEnvironment(
  config: Partial<SafeLocalConfig>,
  environment: NodeJS.ProcessEnv,
): void {
  const environmentProvider = environment.SOFIA_MODEL_PROVIDER?.trim().toLowerCase();
  const localProvider = config.provider?.trim().toLowerCase();
  const useLocalProfile = !environmentProvider || environmentProvider === localProvider;

  if (!environmentProvider && config.provider) environment.SOFIA_MODEL_PROVIDER = config.provider;
  if (useLocalProfile && !environment.SOFIA_MODEL_BASE_URL && config.baseUrl) {
    environment.SOFIA_MODEL_BASE_URL = config.baseUrl;
  }
  if (useLocalProfile && !environment.SOFIA_MODEL_NAME && config.model) {
    environment.SOFIA_MODEL_NAME = config.model;
  }
}
