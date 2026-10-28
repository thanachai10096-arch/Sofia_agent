import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { sofiaStateDirectory } from "../platform/state-directory.js";

export type ModelPreference = "auto" | "fast" | "coding" | "reasoning" | "vision";

export interface ModelPreferenceStore {
  get(ownerKeyId: string): ModelPreference | undefined;
  set(ownerKeyId: string, preference: ModelPreference): void;
}

const VALID = new Set<ModelPreference>(["auto", "fast", "coding", "reasoning", "vision"]);
const OWNER_ID = /^[a-f0-9]{32}$/;

/** Per-API-key model preferences; stores only a profile label, never provider credentials. */
export class FileModelPreferenceStore implements ModelPreferenceStore {
  constructor(private readonly directory = sofiaStateDirectory("model-preferences")) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* platform may not support POSIX modes */ }
  }

  private file(ownerKeyId: string): string {
    if (!OWNER_ID.test(ownerKeyId)) throw new Error("Invalid model preference owner.");
    // Hash the owner ID again so storage names do not expose API-key identifiers.
    return path.join(this.directory, createHash("sha256").update(ownerKeyId).digest("hex") + ".json");
  }

  get(ownerKeyId: string): ModelPreference | undefined {
    const file = this.file(ownerKeyId);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const record = raw as Record<string, unknown>;
      if (record.ownerKeyId !== ownerKeyId || typeof record.modelSelection !== "string" || !VALID.has(record.modelSelection as ModelPreference)) return undefined;
      return record.modelSelection as ModelPreference;
    } catch {
      return undefined;
    }
  }

  set(ownerKeyId: string, preference: ModelPreference): void {
    if (!VALID.has(preference)) throw new Error("Invalid model preference.");
    const target = this.file(ownerKeyId);
    const temp = target + "." + process.pid + "." + randomUUID() + ".tmp";
    const data = JSON.stringify({ ownerKeyId, modelSelection: preference, updatedAt: Date.now() });
    try {
      writeFileSync(temp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { chmodSync(temp, 0o600); } catch { /* platform may not support POSIX modes */ }
      renameSync(temp, target);
    } finally {
      try { unlinkSync(temp); } catch { /* already renamed or absent */ }
    }
  }
}
