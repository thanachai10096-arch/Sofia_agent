import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../security/guard.js";
import { syncDirectoryMetadata } from "./skill-lifecycle.js";
import type { SkillEvaluationCheck } from "./skill-lifecycle.js";

export interface SkillBenchmarkHistoryRecord {
  id: string;
  skillId: string;
  skillVersion: string;
  evaluatedAt: string;
  passed: boolean;
  checks: SkillEvaluationCheck[];
  baselineVersion?: string;
  runId?: string;
}

interface SkillBenchmarkHistorySnapshot {
  schemaVersion: 1;
  records: SkillBenchmarkHistoryRecord[];
}

const MAX_HISTORY_BYTES = 25 * 1024 * 1024;
const MAX_HISTORY_RECORDS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateRecord(value: unknown): SkillBenchmarkHistoryRecord {
  if (!isRecord(value) ||
      typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id) ||
      typeof value.skillId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.skillId) ||
      typeof value.skillVersion !== "string" || !value.skillVersion.trim() || value.skillVersion.length > 100 ||
      typeof value.evaluatedAt !== "string" || !Number.isFinite(Date.parse(value.evaluatedAt)) ||
      typeof value.passed !== "boolean" || !Array.isArray(value.checks) || value.checks.length === 0 ||
      !value.checks.every((check) => isRecord(check) &&
        typeof check.name === "string" && check.name.trim().length > 0 && check.name.length <= 200 &&
        typeof check.passed === "boolean" &&
        (check.detail === undefined || typeof check.detail === "string" && check.detail.length <= 1000)) ||
      new Set(value.checks.map((check) => (check as {name:string}).name.trim())).size !== value.checks.length ||
      (value.baselineVersion !== undefined && (typeof value.baselineVersion !== "string" || value.baselineVersion.length > 100)) ||
      (value.runId !== undefined && (typeof value.runId !== "string" || value.runId.length > 500))) {
    throw new Error("Invalid skill benchmark history record");
  }
  const checks = value.checks.map((check) => ({
    name: check.name.trim(),
    passed: check.passed,
    ...(typeof check.detail === "string" ? { detail: String(redactSecrets(check.detail)).slice(0, 1000) } : {}),
  }));
  return {
    id: value.id,
    skillId: value.skillId,
    skillVersion: value.skillVersion,
    evaluatedAt: value.evaluatedAt,
    passed: value.passed,
    checks,
    ...(typeof value.baselineVersion === "string" ? { baselineVersion: value.baselineVersion } : {}),
    ...(typeof value.runId === "string" ? { runId: String(redactSecrets(value.runId)).slice(0, 500) } : {}),
  };
}

/**
 * Durable, append-only benchmark history. Each append is serialized across
 * processes and committed with fsync + atomic rename. Corrupt or oversized
 * history fails closed; records are never silently truncated or repaired.
 */
export class FileSkillBenchmarkHistory {
  private readonly file: string;

  constructor(file: string) {
    if (!path.isAbsolute(file)) throw new Error("Skill benchmark history path must be absolute");
    this.file = file;
  }

  list(skillId?: string): SkillBenchmarkHistoryRecord[] {
    return this.readSnapshot().records
      .filter((record) => !skillId || record.skillId === skillId)
      .map((record) => JSON.parse(JSON.stringify(record)) as SkillBenchmarkHistoryRecord);
  }

  latest(skillId: string): SkillBenchmarkHistoryRecord | undefined {
    const records = this.list(skillId);
    return records[records.length - 1];
  }

  append(input: Omit<SkillBenchmarkHistoryRecord, "id"> & { id?: string }): SkillBenchmarkHistoryRecord {
    const record = validateRecord({ ...input, id: input.id ?? randomUUID() });
    const directory = path.dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockFile = this.file + ".lock";
    let lockFd: number | undefined;
    let temporary: string | undefined;
    try {
      // Never steal a stale lock automatically: an operator must inspect it.
      lockFd = openSync(lockFile, "wx", 0o600);
      const current = this.readSnapshot();
      const existing = current.records.find((item) => item.id === record.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new Error("Skill benchmark history ID already exists with different content");
        }
        return JSON.parse(JSON.stringify(existing)) as SkillBenchmarkHistoryRecord;
      }
      if (current.records.length >= MAX_HISTORY_RECORDS) {
        throw new Error("Skill benchmark history record limit reached; archive requires operator action");
      }
      const next: SkillBenchmarkHistorySnapshot = {
        schemaVersion: 1,
        records: [...current.records, record],
      };
      const contents = JSON.stringify(next, null, 2) + "\n";
      if (Buffer.byteLength(contents, "utf8") > MAX_HISTORY_BYTES) {
        throw new Error("Skill benchmark history size limit reached; archive requires operator action");
      }
      temporary = this.file + "." + process.pid + "." + randomUUID() + ".tmp";
      writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const fd = openSync(temporary, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      temporary = undefined;
      syncDirectoryMetadata(directory);
      return JSON.parse(JSON.stringify(record)) as SkillBenchmarkHistoryRecord;
    } catch (error) {
      if (temporary) rmSync(temporary, { force: true });
      throw error;
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      if (lockFd !== undefined) rmSync(lockFile, { force: true });
    }
  }

  private readSnapshot(): SkillBenchmarkHistorySnapshot {
    if (!existsSync(this.file)) return { schemaVersion: 1, records: [] };
    if (lstatSync(this.file).isSymbolicLink()) throw new Error("Skill benchmark history file must not be a symbolic link");
    const contents = readFileSync(this.file, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_HISTORY_BYTES) {
      throw new Error("Skill benchmark history exceeds the maximum supported size");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(contents) as unknown; }
    catch { throw new Error("Skill benchmark history is corrupt; refusing to overwrite it"); }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.records) ||
        parsed.records.length > MAX_HISTORY_RECORDS) {
      throw new Error("Skill benchmark history has an unsupported or malformed schema");
    }
    const records = parsed.records.map(validateRecord);
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id)) throw new Error("Skill benchmark history contains duplicate record IDs");
      ids.add(record.id);
    }
    return { schemaVersion: 1, records };
  }
}
