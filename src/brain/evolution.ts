import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";

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
    return this.snapshot.skills[id] ??= {
      id, attempts: 0, successes: 0, failures: 0,
      confidence: 0.5, avgSteps: 0, avgRecoveryRounds: 0,
      successHistory: [], failureHistory: [], taskTypes: {},
    };
  }

  rank(ids: readonly string[], taskType = "general"): SkillRanking[] {
    const key = taskType.trim().toLowerCase() || "general";
    return ids.map(id => {
      const s = this.get(id);
      const globalRate = s.attempts ? s.successes / s.attempts : 0.5;
      const local = s.taskTypes[key];
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
    const key = taskType.trim().toLowerCase() || "general";
    const local = s.taskTypes[key] ??= { attempts: 0, successes: 0, failures: 0 };
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
    const key = taskType.trim().toLowerCase() || "general";
    const local = s.taskTypes[key] ??= { attempts: 0, successes: 0, failures: 0 };
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
    const stats = this.snapshot.taskTypes[taskType] ??= { attempts: 0, successes: 0, failures: 0 };
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
    return this.snapshot.skills[id] ? JSON.parse(JSON.stringify(this.snapshot.skills[id])) as SkillPerformance : undefined;
  }

  getSnapshot(): EvolutionSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot)) as EvolutionSnapshot;
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const serialized = JSON.stringify(this.snapshot, null, 2);
    this.persistChain = this.persistChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file!), { recursive: true });
        const tmp = this.file! + ".tmp";
        await fs.writeFile(tmp, serialized, "utf8");
        await fs.rename(tmp, this.file!);
      } catch {
        // Learning is best-effort; execution semantics never depend on persistence.
      }
    });
    return this.persistChain;
  }
}
