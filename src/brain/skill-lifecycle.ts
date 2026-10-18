import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SkillPackage, SkillsPlatform } from "../skills/platform.js";
import { redactSecrets } from "../security/guard.js";

export type SkillLifecycleStatus = "candidate" | "verified" | "rejected" | "active" | "superseded" | "rolled_back";
export interface SkillEvaluationCheck { name: string; passed: boolean; detail?: string; }
export interface SkillEvaluationResult { passed: boolean; checks: SkillEvaluationCheck[]; evaluatedAt?: string; }
export interface SkillProvenance { source: string; evidenceIds: string[]; confidence: number; }
export interface SkillLifecycleRecord {
  id: string;
  skillId: string;
  package: SkillPackage;
  status: SkillLifecycleStatus;
  provenance: SkillProvenance;
  createdAt: string;
  updatedAt: string;
  evaluation?: SkillEvaluationResult;
}
export interface SkillLifecycleOptions { file: string; minimumConfidence?: number; }
export type SkillCandidateEvaluator = (candidate: SkillPackage) => Promise<SkillEvaluationResult>;
interface LifecycleSnapshot { schemaVersion: 1; records: SkillLifecycleRecord[]; activeBySkill: Record<string, string>; }

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validatePackage(value: SkillPackage): SkillPackage {
  if (!isRecord(value) || !isRecord(value.skill) || typeof value.skill.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.skill.id)) {
    throw new Error("Invalid skill package or skill id");
  }
  if (typeof value.version !== "string" || !value.version.trim() || value.version.length > 100) throw new Error("Invalid skill version");
  return clone(value);
}

/**
 * Versioned candidate lifecycle. Only a candidate that passes an injected evaluator
 * and meets the confidence gate can be promoted into the supplied SkillsPlatform.
 * This class never evaluates or executes skill instructions itself.
 */
export class VersionedSkillLifecycle {
  private snapshot: LifecycleSnapshot = { schemaVersion: 1, records: [], activeBySkill: {} };
  private readonly file: string;
  private readonly minimumConfidence: number;

  constructor(
    private readonly platform: SkillsPlatform,
    private readonly evaluator: SkillCandidateEvaluator,
    options: SkillLifecycleOptions,
  ) {
    if (!path.isAbsolute(options.file)) throw new Error("Skill lifecycle path must be absolute");
    this.file = options.file;
    this.minimumConfidence = options.minimumConfidence ?? 0.7;
    if (!Number.isFinite(this.minimumConfidence) || this.minimumConfidence < 0 || this.minimumConfidence > 1) throw new Error("minimumConfidence must be between 0 and 1");
    this.load();
    const activeRecords: Array<{ skillId: string; record: SkillLifecycleRecord }> = [];
    for (const [skillId, recordId] of Object.entries(this.snapshot.activeBySkill)) {
      const record = this.snapshot.records.find((item) => item.id === recordId && item.skillId === skillId && item.status === "active");
      if (!record) throw new Error("Skill lifecycle active pointer is inconsistent: " + skillId);
      const existing = this.platform.get(skillId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record.package)) {
        throw new Error("Cannot restore active lifecycle skill over a different platform skill: " + skillId);
      }
      activeRecords.push({ skillId, record });
    }
    // Validate the entire restore set before mutating the supplied platform.
    for (const { record } of activeRecords) this.platform.register(clone(record.package));
  }

  propose(skillPackage: SkillPackage, provenance: SkillProvenance): SkillLifecycleRecord {
    const safePackage = validatePackage(skillPackage);
    if (!isRecord(provenance) || typeof provenance.source !== "string" || !provenance.source.trim() ||
        !Array.isArray(provenance.evidenceIds) || !provenance.evidenceIds.every((id) => typeof id === "string" && id.length <= 500) ||
        !Number.isFinite(provenance.confidence) || provenance.confidence < 0 || provenance.confidence > 1) {
      throw new Error("Invalid skill provenance");
    }
    const now = new Date().toISOString();
    const record: SkillLifecycleRecord = {
      id: randomUUID(),
      skillId: safePackage.skill.id,
      package: safePackage,
      status: "candidate",
      provenance: redactSecrets(clone(provenance)) as SkillProvenance,
      createdAt: now,
      updatedAt: now,
    };
    this.snapshot.records.push(record);
    try { this.persist(); }
    catch (error) { this.snapshot.records.pop(); throw error; }
    return clone(record);
  }

  async evaluate(candidateId: string): Promise<SkillLifecycleRecord> {
    const candidate = this.requireRecord(candidateId);
    if (candidate.status !== "candidate") throw new Error("Only candidate skills can be evaluated");
    let result: SkillEvaluationResult;
    try {
      result = await this.evaluator(clone(candidate.package));
    } catch (error) {
      result = { passed: false, checks: [{ name: "evaluator", passed: false, detail: error instanceof Error ? error.message : String(error) }] };
    }
    if (!isRecord(result) || !Array.isArray(result.checks) || result.checks.length === 0 ||
        !result.checks.every((check) => isRecord(check) && typeof check.name === "string" && typeof check.passed === "boolean")) {
      result = { passed: false, checks: [{ name: "evaluation-result", passed: false, detail: "Evaluator returned malformed or empty evidence" }] };
    }
    const before = clone(this.snapshot);
    const record = this.requireRecord(candidateId);
    record.evaluation = {
      passed: result.passed === true && result.checks.every((check) => check.passed === true),
      checks: result.checks.map((check) => ({
        name: check.name.slice(0, 200),
        passed: check.passed,
        ...(typeof check.detail === "string" ? { detail: String(redactSecrets(check.detail)).slice(0, 1000) } : {}),
      })),
      evaluatedAt: new Date().toISOString(),
    };
    record.status = record.evaluation.passed ? "verified" : "rejected";
    record.updatedAt = new Date().toISOString();
    try { this.persist(); }
    catch (error) { this.snapshot = before; throw error; }
    return clone(record);
  }

  promote(candidateId: string): SkillLifecycleRecord {
    const candidate = this.requireRecord(candidateId);
    if (candidate.status !== "verified" || candidate.evaluation?.passed !== true) throw new Error("Only successfully evaluated candidates can be promoted");
    if (candidate.provenance.confidence < this.minimumConfidence) throw new Error("Skill candidate confidence is below the promotion threshold");
    const before = clone(this.snapshot);
    const previousPackage = this.platform.get(candidate.skillId);
    const previousId = this.snapshot.activeBySkill[candidate.skillId];
    // Do not overwrite a skill this lifecycle does not own: there is no
    // managed prior version to restore if promotion or rollback later fails.
    if (!previousId && previousPackage) {
      throw new Error("Cannot promote over an unmanaged skill; adopt it explicitly first");
    }
    const now = new Date().toISOString();
    if (previousId) {
      const previous = this.requireRecord(previousId);
      previous.status = "superseded";
      previous.updatedAt = now;
    }
    const current = this.requireRecord(candidateId);
    current.status = "active";
    current.updatedAt = now;
    this.snapshot.activeBySkill[current.skillId] = current.id;
    try {
      this.platform.register(clone(current.package));
      this.persist();
    } catch (error) {
      this.snapshot = before;
      try {
        if (previousPackage) this.platform.register(previousPackage);
        else this.platform.remove(candidate.skillId);
      } catch { /* Keep original failure; operator must inspect platform consistency. */ }
      throw error;
    }
    return clone(current);
  }

  rollback(skillId: string): SkillLifecycleRecord {
    const activeId = this.snapshot.activeBySkill[skillId];
    if (!activeId) throw new Error("No managed active skill to roll back: " + skillId);
    const active = this.requireRecord(activeId);
    const previous = this.snapshot.records
      .filter((item) => item.skillId === skillId && item.status === "superseded")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!previous) throw new Error("No previous version is available for rollback: " + skillId);
    const before = clone(this.snapshot);
    const platformCurrent = this.platform.get(skillId);
    const now = new Date().toISOString();
    active.status = "rolled_back";
    active.updatedAt = now;
    previous.status = "active";
    previous.updatedAt = now;
    this.snapshot.activeBySkill[skillId] = previous.id;
    try {
      this.platform.register(clone(previous.package));
      this.persist();
    } catch (error) {
      this.snapshot = before;
      try { if (platformCurrent) this.platform.register(platformCurrent); }
      catch { /* Keep original failure; operator must inspect platform consistency. */ }
      throw error;
    }
    return clone(previous);
  }

  get(candidateId: string): SkillLifecycleRecord | undefined {
    const item = this.snapshot.records.find((record) => record.id === candidateId);
    return item ? clone(item) : undefined;
  }
  list(skillId?: string): SkillLifecycleRecord[] {
    return this.snapshot.records.filter((item) => !skillId || item.skillId === skillId).map(clone);
  }
  active(skillId: string): SkillLifecycleRecord | undefined {
    const id = this.snapshot.activeBySkill[skillId];
    return id ? this.get(id) : undefined;
  }

  private requireRecord(id: string): SkillLifecycleRecord {
    const item = this.snapshot.records.find((record) => record.id === id);
    if (!item) throw new Error("Unknown skill lifecycle record: " + id);
    return item;
  }
  private load(): void {
    if (!existsSync(this.file)) return;
    if (lstatSync(this.file).isSymbolicLink()) throw new Error("Skill lifecycle file must not be a symbolic link");
    const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.records) || !isRecord(parsed.activeBySkill)) {
      throw new Error("Unsupported or corrupt skill lifecycle store");
    }
    const records: SkillLifecycleRecord[] = parsed.records.map((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.skillId !== "string" ||
          !["candidate", "verified", "rejected", "active", "superseded", "rolled_back"].includes(String(item.status))) {
        throw new Error("Invalid skill lifecycle record");
      }
      return clone(item) as unknown as SkillLifecycleRecord;
    });
    this.snapshot = { schemaVersion: 1, records, activeBySkill: parsed.activeBySkill as Record<string, string> };
  }
  private persist(): void {
    const directory = path.dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw new Error("Skill lifecycle file must not be a symbolic link");
    const temporary = this.file + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(this.snapshot, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
