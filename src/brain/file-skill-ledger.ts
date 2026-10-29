import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LearnedSkillCandidate, SkillLedger } from "./learning.js";
import type { FailureCategory, Strategy } from "./types.js";
import { redactSecrets } from "../security/guard.js";

interface PersistedSkillLedger { schemaVersion: 1; entries: LearnedSkillCandidate[]; }
const MAX_ENTRIES = 5_000;
const MAX_EVIDENCE_IDS = 100;
const CATEGORIES = new Set<FailureCategory>([
  "syntax_error", "type_error", "runtime_error", "dependency_error", "permission_error",
  "network_error", "tool_error", "wrong_assumption", "incomplete_solution", "environment_error", "unknown",
]);
const STRATEGIES = new Set<Strategy>(["initial", "inspect-evidence", "fix-implementation", "fix-environment", "alternative-tool"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function validateCandidate(value: unknown): LearnedSkillCandidate {
  if (!isRecord(value) ||
      !boundedString(value.name, 200) ||
      !boundedString(value.trigger, 240) ||
      typeof value.category !== "string" || !CATEGORIES.has(value.category as FailureCategory) ||
      typeof value.strategy !== "string" || !STRATEGIES.has(value.strategy as Strategy) ||
      !Array.isArray(value.procedure) || value.procedure.length < 2 || value.procedure.length > 100 ||
      !value.procedure.every((step) => boundedString(step, 2_000)) ||
      !Array.isArray(value.verification) || value.verification.length < 1 || value.verification.length > 3 ||
      !value.verification.every((item) => item === "typecheck" || item === "test" || item === "build") ||
      !Array.isArray(value.evidenceIds) || value.evidenceIds.length < 1 || value.evidenceIds.length > MAX_EVIDENCE_IDS ||
      !value.evidenceIds.every((id) => boundedString(id, 500)) ||
      new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    throw new Error("Invalid learned skill candidate");
  }
  return {
    name: value.name,
    trigger: String(redactSecrets(value.trigger)).slice(0, 240),
    category: value.category as FailureCategory,
    strategy: value.strategy as Strategy,
    procedure: value.procedure.map((step) => String(redactSecrets(step)).slice(0, 2_000)),
    verification: [...value.verification] as string[],
    evidenceIds: [...value.evidenceIds] as string[],
  };
}
function fingerprint(candidate: LearnedSkillCandidate): string {
  return createHash("sha256").update(JSON.stringify({
    name: candidate.name, category: candidate.category, procedure: candidate.procedure,
  })).digest("hex");
}

/**
 * Single-process persistent implementation of the existing SkillLedger contract.
 * This stores bounded, redacted learning metadata only; it does not execute skills.
 */
export class FileSkillLedger implements SkillLedger {
  private entries = new Map<string, LearnedSkillCandidate>();
  private readonly file: string;

  constructor(file: string) {
    if (!path.isAbsolute(file)) throw new Error("Skill ledger path must be absolute");
    this.file = file;
    if (!existsSync(file)) return;
    if (lstatSync(file).isSymbolicLink()) throw new Error("Skill ledger file must not be a symbolic link");
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES) {
      throw new Error("Unsupported or corrupt skill ledger store");
    }
    for (const raw of parsed.entries) {
      const candidate = validateCandidate(raw);
      const key = fingerprint(candidate);
      if (this.entries.has(key)) throw new Error("Duplicate learned skill candidate");
      this.entries.set(key, candidate);
    }
  }

  record(candidate: LearnedSkillCandidate): void {
    const safe = validateCandidate(candidate);
    const key = fingerprint(safe);
    if (this.entries.has(key)) return;
    if (this.entries.size >= MAX_ENTRIES) throw new Error("Skill ledger capacity reached");
    this.entries.set(key, safe);
    try { this.persist(); }
    catch (error) { this.entries.delete(key); throw error; }
  }

  list(): readonly LearnedSkillCandidate[] {
    return [...this.entries.values()].map((candidate) => JSON.parse(JSON.stringify(candidate)) as LearnedSkillCandidate);
  }

  private persist(): void {
    const directory = path.dirname(this.file);
    mkdirSync(directory, { recursive: true });
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) {
      throw new Error("Skill ledger file must not be a symbolic link");
    }
    const payload: PersistedSkillLedger = { schemaVersion: 1, entries: this.list() as LearnedSkillCandidate[] };
    const temporary = this.file + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
