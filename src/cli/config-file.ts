import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SafeLocalConfig {
  provider: string;
  baseUrl: string;
  model: string;
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
    await writeFile(temporaryPath, JSON.stringify(safeConfig, null, 2) + "\\n", {
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
