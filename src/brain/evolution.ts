import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface SkillPerformance {
  id: string;
  attempts: number;
  successes: number;
  failures: number;
  confidence: number;
  avgSteps: number;
  avgRecoveryRounds: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailure?: string;
  successHistory: Array<{ at: string; steps: number; recoveryRounds: number }>;
  failureHistory: Array<{ at: string; message: string }>;
  taskTypes: Record<string, { attempts: number; successes: number; failures: number }>;
}

export interface EvolutionSnapshot {
  version: 1;
  skills: Record<string, SkillPerformance>;
  taskTypes: Record<string, { attempts: number; successes: number; failures: number }>;
}

export interface LearningDiagnostics {
  generatedAt: string;
  totals: { skills: number; attempts: number; successes: number; failures: number; successRate: number };
  taskTypes: EvolutionSnapshot["taskTypes"];
  topSkills: SkillRanking[];
  skillsNeedingAttention: SkillRanking[];
}

export interface SkillRanking {
  id: string;
  score: number;
  confidence: number;
  successRate: number;
  attempts: number;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}


function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizeTaskType(taskType: string): string {
  const normalized = taskType.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 80);
  return normalized || "general";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function normalizeCounters(value: unknown): { attempts: number; successes: number; failures: number } {
  const record = isRecord(value) ? value : {};
  return {
    attempts: nonNegativeNumber(record.attempts),
    successes: nonNegativeNumber(record.successes),
    failures: nonNegativeNumber(record.failures),
  };
}

function normalizePersistedSnapshot(value: unknown): EvolutionSnapshot {
  if (!isRecord(value)) return { version: 1, skills: {}, taskTypes: {} };
  const skills: Record<string, SkillPerformance> = {};
  if (isRecord(value.skills)) {
    for (const [key, raw] of Object.entries(value.skills)) {
      if (!isRecord(raw)) continue;
      const counters = normalizeCounters(raw);
      const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? clamp(raw.confidence, 0, 1)
        : 0.5;
      const taskTypes: SkillPerformance["taskTypes"] = {};
      if (isRecord(raw.taskTypes)) {
        for (const [taskType, stats] of Object.entries(raw.taskTypes)) {
          setOwnValue(taskTypes, taskType, normalizeCounters(stats));
        }
      }
      const successHistory = Array.isArray(raw.successHistory)
        ? raw.successHistory.filter((item): item is { at: string; steps: number; recoveryRounds: number } =>
            isRecord(item) && typeof item.at === "string" &&
            typeof item.steps === "number" && Number.isFinite(item.steps) && item.steps >= 0 &&
            typeof item.recoveryRounds === "number" && Number.isFinite(item.recoveryRounds) && item.recoveryRounds >= 0)
          .slice(-20)
        : [];
      const failureHistory = Array.isArray(raw.failureHistory)
        ? raw.failureHistory.filter((item): item is { at: string; message: string } =>
            isRecord(item) && typeof item.at === "string" && typeof item.message === "string")
          .slice(-20)
        : [];
      setOwnValue(skills, key, {
        id: typeof raw.id === "string" ? raw.id : key,
        ...counters,
        confidence,
        avgSteps: nonNegativeNumber(raw.avgSteps),
        avgRecoveryRounds: nonNegativeNumber(raw.avgRecoveryRounds),
        ...(typeof raw.lastSuccessAt === "string" ? { lastSuccessAt: raw.lastSuccessAt } : {}),
        ...(typeof raw.lastFailureAt === "string" ? { lastFailureAt: raw.lastFailureAt } : {}),
        ...(typeof raw.lastFailure === "string" ? { lastFailure: raw.lastFailure.slice(0, 500) } : {}),
        successHistory,
        failureHistory,
        taskTypes,
      });
    }
  }
  const taskTypes: EvolutionSnapshot["taskTypes"] = {};
  if (isRecord(value.taskTypes)) {
    for (const [key, stats] of Object.entries(value.taskTypes)) {
      setOwnValue(taskTypes, key, normalizeCounters(stats));
    }
  }
  return { version: 1, skills, taskTypes };
}

export class EvolutionEngine {
  private snapshot: EvolutionSnapshot;
  private readonly file?: string;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.file = file;
    this.snapshot = { version: 1, skills: {}, taskTypes: {} };
    if (file) {
      try {
        this.snapshot = normalizePersistedSnapshot(JSON.parse(readFileSync(file, "utf8")) as unknown);
      } catch {
        // A missing/corrupt learning file must never prevent Sofia from running.
      }
    }
  }

  private get(id: string): SkillPerformance {
    const existing = ownValue(this.snapshot.skills, id);
    if (existing) return existing;
    const created: SkillPerformance = {
      id, attempts: 0, successes: 0, failures: 0,
      confidence: 0.5, avgSteps: 0, avgRecoveryRounds: 0,
      successHistory: [], failureHistory: [], taskTypes: {},
    };
    setOwnValue(this.snapshot.skills, id, created);
    return created;
  }

  rank(ids: readonly string[], taskType = "general"): SkillRanking[] {
    const key = normalizeTaskType(taskType);
    return ids.map(id => {
      const s = this.get(id);
      const globalRate = s.attempts ? s.successes / s.attempts : 0.5;
      const local = ownValue(s.taskTypes, key);
      const localEvidence = local ? 1 - Math.exp(-local.attempts / 3) : 0;
      const localRate = local?.attempts ? local.successes / local.attempts : globalRate;
      const rate = globalRate * (1 - localEvidence) + localRate * localEvidence;
      const evidence = 1 - Math.exp(-s.attempts / 5);
      const score = rate * 70 + s.confidence * 20 + evidence * 10 - Math.min(10, s.avgRecoveryRounds * 2);
      return { id, score, confidence: s.confidence, successRate: rate, attempts: local?.attempts ?? s.attempts };
    }).sort((a,b) => b.score-a.score);
  }

  choose(ids: readonly string[], taskType = "general"): string | undefined {
    return this.rank(ids, taskType)[0]?.id;
  }

  recordSuccess(id: string, steps: number, recoveryRounds = 0, taskType = "general"): void {
    const s = this.get(id);
    s.attempts++;
    s.successes++;
    const key = normalizeTaskType(taskType);
    let local = ownValue(s.taskTypes, key);
    if (!local) {
      local = { attempts: 0, successes: 0, failures: 0 };
      setOwnValue(s.taskTypes, key, local);
    }
    local.attempts++;
    local.successes++;
    s.confidence = clamp(s.confidence * 0.8 + 0.2, 0, 1);
    s.avgSteps = s.attempts === 1 ? steps : ((s.avgSteps * (s.attempts - 1)) + steps) / s.attempts;
    s.avgRecoveryRounds = s.attempts === 1 ? recoveryRounds : ((s.avgRecoveryRounds * (s.attempts - 1)) + recoveryRounds) / s.attempts;
    s.lastSuccessAt = new Date().toISOString();
    s.successHistory.push({ at: s.lastSuccessAt, steps, recoveryRounds });
    s.successHistory = s.successHistory.slice(-20);
    void this.persist();
  }

  recordFailure(id: string, message: string, taskType = "general"): void {
    const s = this.get(id);
    s.attempts++;
    s.failures++;
    const key = normalizeTaskType(taskType);
    let local = ownValue(s.taskTypes, key);
    if (!local) {
      local = { attempts: 0, successes: 0, failures: 0 };
      setOwnValue(s.taskTypes, key, local);
    }
    local.attempts++;
    local.failures++;
    s.confidence = clamp(s.confidence * 0.75 - 0.05, 0.05, 0.95);
    s.lastFailureAt = new Date().toISOString();
    s.lastFailure = message.slice(0, 500);
    s.failureHistory.push({ at: s.lastFailureAt, message: s.lastFailure });
    s.failureHistory = s.failureHistory.slice(-20);
    void this.persist();
  }

  recordRun(taskType: string, completed: boolean): void {
    const key = normalizeTaskType(taskType);
    let stats = ownValue(this.snapshot.taskTypes, key);
    if (!stats) {
      stats = { attempts: 0, successes: 0, failures: 0 };
      setOwnValue(this.snapshot.taskTypes, key, stats);
    }
    stats.attempts++;
    completed ? stats.successes++ : stats.failures++;
    void this.persist();
  }

  getDiagnostics(): LearningDiagnostics {
    const snapshot = this.getSnapshot();
    const skills = Object.values(snapshot.skills);
    const attempts = skills.reduce((sum, skill) => sum + skill.attempts, 0);
    const successes = skills.reduce((sum, skill) => sum + skill.successes, 0);
    const failures = skills.reduce((sum, skill) => sum + skill.failures, 0);
    const ranked = this.rank(skills.map(skill => skill.id));
    return {
      generatedAt: new Date().toISOString(),
      totals: { skills: skills.length, attempts, successes, failures, successRate: attempts ? successes / attempts : 0 },
      taskTypes: snapshot.taskTypes,
      topSkills: ranked.slice(0, 10),
      skillsNeedingAttention: ranked.filter(item => item.attempts >= 2 && item.successRate < 0.5).slice(-10).reverse(),
    };
  }

  async flush(): Promise<void> {
    await this.persistChain;
  }

  getSkill(id: string): SkillPerformance | undefined {
    const skill = ownValue(this.snapshot.skills, id);
    return skill ? JSON.parse(JSON.stringify(skill)) as SkillPerformance : undefined;
  }

  getSnapshot(): EvolutionSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot)) as EvolutionSnapshot;
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const serialized = JSON.stringify(this.snapshot, null, 2);
    this.persistChain = this.persistChain.then(async () => {
      const tmp = this.file! + "." + process.pid + "." + randomUUID() + ".tmp";
      try {
        await fs.mkdir(path.dirname(this.file!), { recursive: true });
        await fs.writeFile(tmp, serialized, { encoding: "utf8", flag: "wx" });
        await fs.rename(tmp, this.file!);
      } catch {
        // Learning is best-effort; execution semantics never depend on persistence.
        // Never leave a temporary snapshot behind after a failed write/rename.
        await fs.rm(tmp, { force: true }).catch(() => undefined);
      }
    });
    return this.persistChain;
  }
}
