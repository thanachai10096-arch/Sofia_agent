import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface SkillOutcomeMetrics {
  durationMs?: number;
  toolCalls?: number;
}

export interface SkillPerformance {
  id: string;
  attempts: number;
  successes: number;
  failures: number;
  confidence: number;
  avgSteps: number;
  avgRecoveryRounds: number;
  avgDurationMs: number;
  avgToolCalls: number;
  durationSamples: number;
  toolCallSamples: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailure?: string;
  successHistory: Array<{ at: string; steps: number; recoveryRounds: number; durationMs?: number; toolCalls?: number }>;
  failureHistory: Array<{ at: string; message: string; durationMs?: number; toolCalls?: number }>;
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
  avgDurationMs: number;
  avgToolCalls: number;
  efficiencyPenalty: number;
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

export class EvolutionEngine {
  private snapshot: EvolutionSnapshot;
  private readonly file?: string;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.file = file;
    this.snapshot = { version: 1, skills: {}, taskTypes: {} };
    if (file) {
      try {
        const loaded = JSON.parse(readFileSync(file, "utf8")) as Partial<EvolutionSnapshot>;
        const skills = loaded.skills ?? {};
        this.snapshot = {
          version: 1,
          skills: Object.fromEntries(Object.entries(skills).map(([id, skill]) => [id, {
            ...skill,
            id: skill.id ?? id,
            avgDurationMs: Number.isFinite(skill.avgDurationMs) ? skill.avgDurationMs : 0,
            avgToolCalls: Number.isFinite(skill.avgToolCalls) ? skill.avgToolCalls : 0,
            durationSamples: Number.isSafeInteger(skill.durationSamples) ? skill.durationSamples : 0,
            toolCallSamples: Number.isSafeInteger(skill.toolCallSamples) ? skill.toolCallSamples : 0,
            taskTypes: skill.taskTypes ?? {},
            successHistory: skill.successHistory ?? [],
            failureHistory: skill.failureHistory ?? [],
          }])),
          taskTypes: loaded.taskTypes ?? {},
        };
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
      avgDurationMs: 0, avgToolCalls: 0, durationSamples: 0, toolCallSamples: 0,
      successHistory: [], failureHistory: [], taskTypes: {},
    };
    setOwnValue(this.snapshot.skills, id, created);
    return created;
  }

  rank(ids: readonly string[], taskType = "general"): SkillRanking[] {
    const key = normalizeTaskType(taskType);
    const candidates = ids.map(id => ({ id, skill: this.get(id) }));
    const median = (values: number[]): number => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    const durationBaseline = median(candidates
      .filter(item => item.skill.durationSamples > 0 && item.skill.avgDurationMs > 0)
      .map(item => item.skill.avgDurationMs));
    const callsBaseline = median(candidates
      .filter(item => item.skill.toolCallSamples > 0 && item.skill.avgToolCalls > 0)
      .map(item => item.skill.avgToolCalls));
    return candidates.map(({ id, skill: s }) => {
      // Use a Beta(1, 1) prior so one lucky outcome does not make a
      // barely-tested skill appear perfectly reliable. As evidence grows,
      // the smoothed estimate converges toward the observed success rate.
      const globalRate = (s.successes + 1) / (s.attempts + 2);
      const local = ownValue(s.taskTypes, key);
      const localEvidence = local ? 1 - Math.exp(-local.attempts / 3) : 0;
      const localRate = local
        ? (local.successes + 1) / (local.attempts + 2)
        : globalRate;
      const rate = globalRate * (1 - localEvidence) + localRate * localEvidence;
      const evidence = 1 - Math.exp(-s.attempts / 5);
      // Compare execution cost only among the current candidates and only when
      // real samples exist. Missing/legacy metrics never count as zero-cost wins.
      const durationPenalty = durationBaseline > 0 && s.durationSamples > 0 && s.avgDurationMs > 0
        ? clamp((s.avgDurationMs / durationBaseline - 1) * 4, 0, 8)
        : 0;
      const callsPenalty = callsBaseline > 0 && s.toolCallSamples > 0 && s.avgToolCalls > 0
        ? clamp((s.avgToolCalls / callsBaseline - 1) * 2, 0, 4)
        : 0;
      const efficiencyPenalty = durationPenalty + callsPenalty;
      const score = rate * 70 + s.confidence * 20 + evidence * 10
        - Math.min(10, s.avgRecoveryRounds * 2) - efficiencyPenalty;
      return {
        id, score, confidence: s.confidence, successRate: rate,
        attempts: local?.attempts ?? s.attempts,
        avgDurationMs: s.avgDurationMs,
        avgToolCalls: s.avgToolCalls,
        efficiencyPenalty,
      };
    }).sort((a,b) => b.score-a.score);
  }

  choose(ids: readonly string[], taskType = "general"): string | undefined {
    return this.rank(ids, taskType)[0]?.id;
  }

  recordSuccess(id: string, steps: number, recoveryRounds = 0, taskType = "general", metrics: SkillOutcomeMetrics = {}): void {
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
    const durationMs = Number.isFinite(metrics.durationMs) ? Math.max(0, metrics.durationMs!) : undefined;
    const toolCalls = Number.isFinite(metrics.toolCalls) ? Math.max(0, metrics.toolCalls!) : undefined;
    if (durationMs !== undefined) {
      s.durationSamples++;
      s.avgDurationMs += (durationMs - s.avgDurationMs) / s.durationSamples;
    }
    if (toolCalls !== undefined) {
      s.toolCallSamples++;
      s.avgToolCalls += (toolCalls - s.avgToolCalls) / s.toolCallSamples;
    }
    s.lastSuccessAt = new Date().toISOString();
    s.successHistory.push({
      at: s.lastSuccessAt, steps, recoveryRounds,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
    });
    s.successHistory = s.successHistory.slice(-20);
    void this.persist();
  }

  recordFailure(id: string, message: string, taskType = "general", metrics: SkillOutcomeMetrics = {}): void {
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
    const durationMs = Number.isFinite(metrics.durationMs) ? Math.max(0, metrics.durationMs!) : undefined;
    const toolCalls = Number.isFinite(metrics.toolCalls) ? Math.max(0, metrics.toolCalls!) : undefined;
    if (durationMs !== undefined) {
      s.durationSamples++;
      s.avgDurationMs += (durationMs - s.avgDurationMs) / s.durationSamples;
    }
    if (toolCalls !== undefined) {
      s.toolCallSamples++;
      s.avgToolCalls += (toolCalls - s.avgToolCalls) / s.toolCallSamples;
    }
    s.failureHistory.push({
      at: s.lastFailureAt, message: s.lastFailure,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
    });
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
