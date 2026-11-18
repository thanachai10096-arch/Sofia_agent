import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SkillPackage, SkillsPlatform } from "../skills/platform.js";
import { redactSecrets } from "../security/guard.js";

export type SkillLifecycleStatus = "candidate" | "verified" | "rejected" | "active" | "superseded" | "rolled_back";
export interface SkillEvaluationCheck { name: string; passed: boolean; detail?: string; }
export interface SkillEvaluationResult { passed: boolean; checks: SkillEvaluationCheck[]; evaluatedAt?: string; }
export interface SkillProvenance { source: string; evidenceIds: string[]; confidence: number; runId?: string; skillDigest?: string; }
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
export type SkillCandidateEvaluator = (candidate: SkillPackage, provenance: SkillProvenance) => Promise<SkillEvaluationResult>;
interface LifecycleSnapshot { schemaVersion: 1; records: SkillLifecycleRecord[]; activeBySkill: Record<string, string>; }
export interface SkillMutationLockInfo {
  locked: boolean;
  owner?: { pid: number; hostname: string; startedAt: string; nonce: string };
  malformed?: boolean;
}
interface SkillMutationLockOwner { schemaVersion: 1; pid: number; hostname: string; startedAt: string; nonce: string; }
interface SkillMutationJournal {
  schemaVersion: 1;
  transactionId: string;
  operation: "promote" | "rollback";
  skillId: string;
  previousActiveId: string | null;
  targetActiveId: string;
  previousPackage: SkillPackage | null;
  targetPackage: SkillPackage;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validatePackage(value: SkillPackage): SkillPackage {
  if (!isRecord(value) || !isRecord(value.skill) || typeof value.skill.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.skill.id)) {
    throw new Error("Invalid skill package or skill id");
  }
  if (typeof value.version !== "string" || !value.version.trim() || value.version.length > 100) throw new Error("Invalid skill version");
  if (!["builtin", "learned", "project", "custom", "marketplace"].includes(String(value.source))) throw new Error("Invalid skill source");
  const skill = value.skill;
  if (typeof skill.name !== "string" || !skill.name.trim() || skill.name.length > 200 ||
      typeof skill.description !== "string" || !skill.description.trim() || skill.description.length > 2000 ||
      !Array.isArray(skill.triggers) || skill.triggers.length === 0 || !skill.triggers.every((item) => typeof item === "string" && item.trim() && item.length <= 500) ||
      !Array.isArray(skill.categories) || skill.categories.length === 0 || !skill.categories.every((item) => typeof item === "string" && item.trim() && item.length <= 100) ||
      !["initial", "inspect-evidence", "fix-implementation", "fix-environment", "alternative-tool"].includes(String(skill.strategy)) ||
      !Array.isArray(skill.procedure) || skill.procedure.length < 2 || !skill.procedure.every((item) => typeof item === "string" && item.trim() && item.length <= 2000) ||
      !Array.isArray(skill.verification) || skill.verification.length === 0 || !skill.verification.every((item) => ["typecheck", "test", "build"].includes(String(item)))) {
    throw new Error("Invalid skill metadata");
  }
  if (value.publisher !== undefined && (typeof value.publisher !== "string" || value.publisher.length > 200)) throw new Error("Invalid skill publisher");
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
  private readonly evaluations = new Map<string, Promise<SkillLifecycleRecord>>();
  private persistedSnapshot: string | null = null;

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
    this.withPlatformMutationLock(() => {
      this.recoverPendingMutation();
      // Persisted learned skills in verified, active, or rollback-eligible superseded
      // state must not be promoted/restored using a cached evaluation. Re-evaluation
      // must resolve the durable audit evidence again after restart.
      let quarantinedLearnedSkills = false;
      for (const record of this.snapshot.records) {
        if (record.package.source !== "learned" || (record.status !== "active" && record.status !== "verified" && record.status !== "superseded")) continue;
        const wasActive = record.status === "active";
        record.status = "rejected";
        record.updatedAt = new Date().toISOString();
        record.evaluation = {
          passed: false,
          evaluatedAt: record.updatedAt,
          checks: [{ name: "startup-evidence-quarantine", passed: false, detail: "Persisted learned skills require fresh durable-evidence evaluation after restart; cached verification cannot be promoted." }],
        };
        if (wasActive && this.snapshot.activeBySkill[record.skillId] === record.id) {
          delete this.snapshot.activeBySkill[record.skillId];
        }
        quarantinedLearnedSkills = true;
      }
      if (quarantinedLearnedSkills) this.persist();
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
      const installedDuringRestore: string[] = [];
      try {
        for (const { skillId, record } of activeRecords) {
          const existed = this.platform.get(skillId) !== undefined;
          if (!existed) installedDuringRestore.push(skillId);
          this.platform.register(clone(record.package));
        }
      } catch (error) {
        // Undo only entries introduced by this restore attempt; never remove
        // packages that were already present and validated as identical.
        const compensationErrors: unknown[] = [];
        for (const skillId of installedDuringRestore.reverse()) {
          try {
            const removed = this.platform.remove(skillId);
            if (!removed && this.platform.get(skillId) !== undefined) {
              compensationErrors.push(new Error("Could not confirm removal of partially restored skill: " + skillId));
            }
          } catch (compensationError) {
            compensationErrors.push(compensationError);
          }
        }
        if (compensationErrors.length > 0) {
          throw new AggregateError(
            [error, ...compensationErrors],
            "Skill startup restore failed and compensation was incomplete; platform state requires operator reconciliation",
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  propose(skillPackage: SkillPackage, provenance: SkillProvenance): SkillLifecycleRecord {
    return this.withPlatformMutationLock(() => this.proposeWithLock(skillPackage, provenance));
  }

  private proposeWithLock(skillPackage: SkillPackage, provenance: SkillProvenance): SkillLifecycleRecord {
    const safePackage = validatePackage(skillPackage);
    if (!isRecord(provenance) || typeof provenance.source !== "string" || !provenance.source.trim() ||
        !Array.isArray(provenance.evidenceIds) || provenance.evidenceIds.length === 0 ||
        !provenance.evidenceIds.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 500) ||
        new Set(provenance.evidenceIds).size !== provenance.evidenceIds.length ||
        (provenance.runId !== undefined && (typeof provenance.runId !== "string" || !provenance.runId.trim() || provenance.runId.length > 500)) ||
        (provenance.skillDigest !== undefined && (typeof provenance.skillDigest !== "string" || !/^[a-f0-9]{64}$/.test(provenance.skillDigest))) ||
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

  evaluate(candidateId: string): Promise<SkillLifecycleRecord> {
    const inFlight = this.evaluations.get(candidateId);
    if (inFlight) return inFlight;
    const operation = this.evaluateCandidate(candidateId);
    this.evaluations.set(candidateId, operation);
    void operation.finally(() => {
      if (this.evaluations.get(candidateId) === operation) this.evaluations.delete(candidateId);
    }).catch(() => undefined);
    return operation;
  }

  private async evaluateCandidate(candidateId: string): Promise<SkillLifecycleRecord> {
    const candidate = this.requireRecord(candidateId);
    if (candidate.status !== "candidate") throw new Error("Only candidate skills can be evaluated");
    let result: SkillEvaluationResult;
    try {
      result = await this.evaluator(clone(candidate.package), clone(candidate.provenance));
    } catch (error) {
      result = { passed: false, checks: [{ name: "evaluator", passed: false, detail: error instanceof Error ? error.message : String(error) }] };
    }
    if (!isRecord(result) || !Array.isArray(result.checks) || result.checks.length === 0 ||
        !result.checks.every((check) => isRecord(check) && typeof check.name === "string" && typeof check.passed === "boolean")) {
      result = { passed: false, checks: [{ name: "evaluation-result", passed: false, detail: "Evaluator returned malformed or empty evidence" }] };
    }
    return this.withPlatformMutationLock(() => {
      const before = clone(this.snapshot);
      const record = this.requireRecord(candidateId);
      if (record.status !== "candidate") throw new Error("Candidate changed while evaluation was running; reload before writing");
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
    });
  }

  promote(candidateId: string): SkillLifecycleRecord {
    return this.withPlatformMutationLock(() => this.promoteWithLock(candidateId));
  }

  private promoteWithLock(candidateId: string): SkillLifecycleRecord {
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
    this.writeMutationJournal({
      schemaVersion: 1, transactionId: randomUUID(), operation: "promote",
      skillId: current.skillId, previousActiveId: previousId ?? null,
      targetActiveId: current.id, previousPackage: previousPackage ? clone(previousPackage) : null,
      targetPackage: clone(current.package),
    });
    try {
      this.platform.register(clone(current.package));
      this.persist();
    } catch (error) {
      this.snapshot = before;
      try {
        if (previousPackage) this.platform.register(previousPackage);
        else this.platform.remove(candidate.skillId);
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          "Skill promotion failed and platform compensation was incomplete; operator reconciliation is required",
          { cause: error },
        );
      }
      throw error;
    }
    // Snapshot commit is authoritative. A cleanup failure leaves a recoverable
    // journal but must never roll back an already committed platform mutation.
    this.clearMutationJournal();
    return clone(current);
  }

  rollback(skillId: string): SkillLifecycleRecord {
    return this.withPlatformMutationLock(() => this.rollbackWithLock(skillId));
  }

  private rollbackWithLock(skillId: string): SkillLifecycleRecord {
    const activeId = this.snapshot.activeBySkill[skillId];
    if (!activeId) throw new Error("No managed active skill to roll back: " + skillId);
    const active = this.requireRecord(activeId);
    const previous = this.snapshot.records
      .filter((item) => item.skillId === skillId && item.status === "superseded")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!previous) throw new Error("No previous version is available for rollback: " + skillId);
    // Learned artifacts are never reactivated through rollback: rollback has no
    // trusted-evidence verifier here, so cached provenance/evaluation is insufficient.
    // A learned skill must be proposed and evaluated again through the managed workflow.
    if (previous.package.source === "learned") {
      throw new Error("Cannot roll back to a learned skill without fresh durable-evidence verification: " + skillId);
    }
    const before = clone(this.snapshot);
    const platformCurrent = this.platform.get(skillId);
    const now = new Date().toISOString();
    active.status = "rolled_back";
    active.updatedAt = now;
    previous.status = "active";
    previous.updatedAt = now;
    this.snapshot.activeBySkill[skillId] = previous.id;
    this.writeMutationJournal({
      schemaVersion: 1, transactionId: randomUUID(), operation: "rollback",
      skillId, previousActiveId: active.id, targetActiveId: previous.id,
      previousPackage: platformCurrent ? clone(platformCurrent) : null,
      targetPackage: clone(previous.package),
    });
    try {
      this.platform.register(clone(previous.package));
      this.persist();
      this.clearMutationJournal();
    } catch (error) {
      this.snapshot = before;
      try {
        if (platformCurrent) this.platform.register(platformCurrent);
        else this.platform.remove(skillId);
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          "Skill rollback failed and platform compensation was incomplete; operator reconciliation is required",
          { cause: error },
        );
      }
      throw error;
    }
    // Keep the committed target if journal cleanup fails; startup recovery
    // will verify the snapshot and finish cleanup on the next process start.
    this.clearMutationJournal();
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

  inspectMutationLock(): SkillMutationLockInfo {
    const lockFile = this.file + ".mutation.lock";
    if (!existsSync(lockFile)) return { locked: false };
    if (lstatSync(lockFile).isSymbolicLink()) return { locked: true, malformed: true };
    try {
      const parsed = JSON.parse(readFileSync(lockFile, "utf8")) as unknown;
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 ||
          typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
          typeof parsed.hostname !== "string" || !parsed.hostname ||
          typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt)) ||
          typeof parsed.nonce !== "string" || !parsed.nonce) {
        return { locked: true, malformed: true };
      }
      return { locked: true, owner: {
        pid: parsed.pid, hostname: parsed.hostname, startedAt: parsed.startedAt, nonce: parsed.nonce,
      } };
    } catch {
      return { locked: true, malformed: true };
    }
  }

  private get mutationJournalFile(): string { return this.file + ".transaction.json"; }

  private writeMutationJournal(journal: SkillMutationJournal): void {
    const target = validatePackage(journal.targetPackage);
    const previous = journal.previousPackage ? validatePackage(journal.previousPackage) : null;
    if (target.skill.id !== journal.skillId || (previous && previous.skill.id !== journal.skillId) ||
        !journal.transactionId || !journal.targetActiveId) throw new Error("Invalid skill mutation journal");
    const journalFile = this.mutationJournalFile;
    if (existsSync(journalFile)) {
      throw new Error("A pending skill mutation journal requires recovery before another platform mutation");
    }
    const temporary = journalFile + "." + process.pid + "." + randomUUID() + ".tmp";
    const contents = JSON.stringify({ ...journal, targetPackage: target, previousPackage: previous }, null, 2) + "\n";
    try {
      writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const fd = openSync(temporary, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, journalFile);
      const directoryFd = openSync(path.dirname(journalFile), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private clearMutationJournal(): void {
    rmSync(this.mutationJournalFile, { force: true });
    const directoryFd = openSync(path.dirname(this.mutationJournalFile), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }

  private recoverPendingMutation(): void {
    const journalFile = this.mutationJournalFile;
    if (!existsSync(journalFile)) return;
    if (lstatSync(journalFile).isSymbolicLink()) throw new Error("Skill mutation journal must not be a symbolic link");
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(journalFile, "utf8")) as unknown; }
    catch { throw new Error("Skill mutation journal is corrupt; operator reconciliation is required"); }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 ||
        !["promote", "rollback"].includes(String(parsed.operation)) ||
        typeof parsed.transactionId !== "string" || !parsed.transactionId ||
        typeof parsed.skillId !== "string" || !parsed.skillId ||
        (parsed.previousActiveId !== null && typeof parsed.previousActiveId !== "string") ||
        typeof parsed.targetActiveId !== "string" || !parsed.targetActiveId) {
      throw new Error("Skill mutation journal is invalid; operator reconciliation is required");
    }
    const targetPackage = validatePackage(parsed.targetPackage as SkillPackage);
    const previousPackage = parsed.previousPackage === null ? null : validatePackage(parsed.previousPackage as SkillPackage);
    if (targetPackage.skill.id !== parsed.skillId || (previousPackage && previousPackage.skill.id !== parsed.skillId)) {
      throw new Error("Skill mutation journal package identity mismatch; operator reconciliation is required");
    }
    if (parsed.previousActiveId === null && previousPackage !== null) {
      throw new Error("Skill mutation journal has an impossible previous package; operator reconciliation is required");
    }
    const targetRecord = this.snapshot.records.find((record) =>
      record.id === parsed.targetActiveId && record.skillId === parsed.skillId);
    if (!targetRecord || JSON.stringify(targetRecord.package) !== JSON.stringify(targetPackage)) {
      throw new Error("Skill mutation journal target does not match the lifecycle store; operator reconciliation is required");
    }
    const currentActiveId = this.snapshot.activeBySkill[parsed.skillId] ?? null;
    const committed = currentActiveId === parsed.targetActiveId;
    if (committed) {
      if (targetRecord.status !== "active") {
        throw new Error("Committed journal target is not active in the lifecycle store; operator reconciliation is required");
      }
    } else {
      if (currentActiveId !== parsed.previousActiveId) {
        throw new Error("Lifecycle active pointer matches neither side of the pending journal; operator reconciliation is required");
      }
      if (parsed.previousActiveId !== null) {
        const previousRecord = this.snapshot.records.find((record) =>
          record.id === parsed.previousActiveId && record.skillId === parsed.skillId);
        if (!previousRecord || previousPackage === null ||
            JSON.stringify(previousRecord.package) !== JSON.stringify(previousPackage) ||
            previousRecord.status !== "active") {
          throw new Error("Pending journal previous version does not match the lifecycle store; operator reconciliation is required");
        }
      } else if (currentActiveId !== null) {
        throw new Error("Pending journal unexpectedly has an active lifecycle pointer");
      }
    }
    const expected = committed ? targetPackage : previousPackage;
    const current = this.platform.get(parsed.skillId);
    if (current && JSON.stringify(current) !== JSON.stringify(targetPackage) &&
        (!previousPackage || JSON.stringify(current) !== JSON.stringify(previousPackage))) {
      throw new Error("Cannot recover skill mutation over an externally changed platform package: " + parsed.skillId);
    }
    if (expected) this.platform.register(clone(expected));
    else if (current) this.platform.remove(parsed.skillId);
    this.clearMutationJournal();
  }

  private withPlatformMutationLock<T>(operation: () => T): T {
    const directory = path.dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockFile = this.file + ".mutation.lock";
    let lockFd: number | undefined;
    try {
      // Serialize external platform side effects across processes. The
      // snapshot comparison must happen while holding this lock, before
      // register/remove can mutate the shared platform.
      lockFd = openSync(lockFile, "wx", 0o600);
      const lockOwner: SkillMutationLockOwner = {
        schemaVersion: 1, pid: process.pid, hostname: hostname(),
        startedAt: new Date().toISOString(), nonce: randomUUID(),
      };
      writeFileSync(lockFd, JSON.stringify(lockOwner), "utf8");
      fsyncSync(lockFd);
      if (existsSync(this.file)) {
        if (lstatSync(this.file).isSymbolicLink()) throw new Error("Skill lifecycle file must not be a symbolic link");
        const current = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
        const currentSnapshot = JSON.stringify(current, null, 2) + "\n";
        if (this.persistedSnapshot === null || currentSnapshot !== this.persistedSnapshot) {
          throw new Error("Skill lifecycle store changed in another process; reload before platform mutation");
        }
      } else if (this.persistedSnapshot !== null) {
        throw new Error("Skill lifecycle store was removed in another process; reload before platform mutation");
      }
      return operation();
    } finally {
      if (lockFd !== undefined) {
        const owned = fstatSync(lockFd);
        closeSync(lockFd);
        try {
          const current = lstatSync(lockFile);
          if (current.dev === owned.dev && current.ino === owned.ino) rmSync(lockFile);
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") throw error;
        }
      }
    }
  }

  private requireRecord(id: string): SkillLifecycleRecord {
    const item = this.snapshot.records.find((record) => record.id === id);
    if (!item) throw new Error("Unknown skill lifecycle record: " + id);
    return item;
  }
  private load(): void {
    if (!existsSync(this.file)) return;
    if (lstatSync(this.file).isSymbolicLink()) throw new Error("Skill lifecycle file must not be a symbolic link");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    } catch {
      // Never replace or silently reset a damaged lifecycle store: it may
      // contain the only durable record of an approved skill transition.
      throw new Error("Unsupported or corrupt skill lifecycle store");
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.records) || !isRecord(parsed.activeBySkill)) {
      throw new Error("Unsupported or corrupt skill lifecycle store");
    }
    const recordIds = new Set<string>();
    const records: SkillLifecycleRecord[] = parsed.records.map((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || item.id.length > 200 ||
          typeof item.skillId !== "string" || !item.skillId.trim() ||
          !["candidate", "verified", "rejected", "active", "superseded", "rolled_back"].includes(String(item.status)) ||
          !isRecord(item.provenance) || typeof item.provenance.source !== "string" || !item.provenance.source.trim() ||
          !Array.isArray(item.provenance.evidenceIds) || !item.provenance.evidenceIds.every((id) => typeof id === "string" && id.length <= 500) ||
          (item.provenance.skillDigest !== undefined && (typeof item.provenance.skillDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.provenance.skillDigest))) ||
          (item.provenance.runId !== undefined && (typeof item.provenance.runId !== "string" || !item.provenance.runId.trim() || item.provenance.runId.length > 500)) ||
          typeof item.provenance.confidence !== "number" || !Number.isFinite(item.provenance.confidence) ||
          item.provenance.confidence < 0 || item.provenance.confidence > 1 ||
          typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") {
        throw new Error("Invalid skill lifecycle record");
      }
      if (recordIds.has(item.id)) throw new Error("Duplicate skill lifecycle record id");
      recordIds.add(item.id);
      if (item.provenance.source.length > 200 || item.provenance.evidenceIds.length === 0 ||
          !item.provenance.evidenceIds.every((id) => id.trim().length > 0) ||
          new Set(item.provenance.evidenceIds).size !== item.provenance.evidenceIds.length) {
        throw new Error("Invalid skill lifecycle provenance evidence");
      }
      const safePackage = validatePackage(item.package as SkillPackage);
      if (safePackage.skill.id !== item.skillId) throw new Error("Skill lifecycle package id does not match record");
      if (item.evaluation !== undefined) {
        if (!isRecord(item.evaluation) || typeof item.evaluation.passed !== "boolean" || !Array.isArray(item.evaluation.checks) ||
            item.evaluation.checks.length === 0 || !item.evaluation.checks.every((check) =>
              isRecord(check) && typeof check.name === "string" && typeof check.passed === "boolean")) {
          throw new Error("Invalid skill lifecycle evaluation");
        }
      }
      if (item.status === "active" &&
          (!isRecord(item.evaluation) || item.evaluation.passed !== true ||
           !Array.isArray(item.evaluation.checks) || item.evaluation.checks.length === 0 ||
           !item.evaluation.checks.every((check) => isRecord(check) && check.passed === true) ||
           item.provenance.confidence < this.minimumConfidence)) {
        throw new Error("Active skill lifecycle record lacks valid evaluation or confidence");
      }
      return { ...(clone(item) as unknown as SkillLifecycleRecord), package: safePackage };
    });
    const activeBySkill: Record<string, string> = {};
    for (const [skillId, recordId] of Object.entries(parsed.activeBySkill)) {
      if (typeof recordId !== "string" || !recordId.trim()) throw new Error("Invalid skill lifecycle active pointer");
      const record = records.find((item) => item.id === recordId && item.skillId === skillId && item.status === "active");
      if (!record) throw new Error("Skill lifecycle active pointer is inconsistent: " + skillId);
      if (Object.prototype.hasOwnProperty.call(activeBySkill, skillId)) throw new Error("Duplicate skill lifecycle active pointer");
      activeBySkill[skillId] = recordId;
    }
    for (const record of records) {
      if (record.status === "active" && activeBySkill[record.skillId] !== record.id) {
        throw new Error("Active skill lifecycle record is missing its active pointer: " + record.skillId);
      }
    }
    this.snapshot = { schemaVersion: 1, records, activeBySkill };
    this.persistedSnapshot = JSON.stringify(this.snapshot, null, 2) + "\n";
  }
  private persist(): void {
    const directory = path.dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockFile = this.file + ".lock";
    let lockFd: number | undefined;
    let temporary: string | undefined;
    try {
      // O_EXCL serializes writers across processes. Stale locks fail closed and
      // require operator recovery rather than unsafe automatic lock stealing.
      lockFd = openSync(lockFile, "wx", 0o600);
      if (existsSync(this.file)) {
        if (lstatSync(this.file).isSymbolicLink()) throw new Error("Skill lifecycle file must not be a symbolic link");
        const current = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
        const currentSnapshot = JSON.stringify(current, null, 2) + "\n";
        if (this.persistedSnapshot === null || currentSnapshot !== this.persistedSnapshot) {
          throw new Error("Skill lifecycle store changed in another process; reload before writing");
        }
      } else if (this.persistedSnapshot !== null) {
        throw new Error("Skill lifecycle store was removed in another process; reload before writing");
      }

      temporary = this.file + "." + process.pid + "." + randomUUID() + ".tmp";
      const nextSnapshot = JSON.stringify(this.snapshot, null, 2) + "\n";
      writeFileSync(temporary, nextSnapshot, { encoding: "utf8", flag: "wx", mode: 0o600 });
      // Flush file contents before the atomic rename so a successful write is
      // not merely resident in the OS page cache.
      const temporaryFd = openSync(temporary, "r");
      try { fsyncSync(temporaryFd); }
      finally { closeSync(temporaryFd); }
      renameSync(temporary, this.file);
      temporary = undefined;
      // Update the in-memory baseline immediately after rename: a subsequent
      // directory-fsync error must not make this process believe the old file
      // is still on disk.
      this.persistedSnapshot = nextSnapshot;
      const directoryFd = openSync(directory, "r");
      try { fsyncSync(directoryFd); }
      finally { closeSync(directoryFd); }
    } catch (error) {
      if (temporary) rmSync(temporary, { force: true });
      throw error;
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      if (lockFd !== undefined) rmSync(lockFile, { force: true });
    }
  }
}
