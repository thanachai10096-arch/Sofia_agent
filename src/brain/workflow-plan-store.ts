import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sofiaStateDirectory } from "../platform/state-directory.js";

export type WorkflowPlanStatus = "draft" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
export type WorkflowStepStatus = "pending" | "ready" | "running" | "waiting_approval" | "succeeded" | "failed" | "skipped" | "cancelled";
export interface WorkflowStepRecord {
  id: string;
  title: string;
  description: string;
  idempotent: boolean;
  dependsOn: string[];
  risk?: "low" | "medium" | "high";
  maxAttempts?: number;
  status: WorkflowStepStatus;
  attempts: number;
  evidenceIds: string[];
  updatedAt: string;
  lastError?: string;
}
export interface WorkflowPlan {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: WorkflowPlanStatus;
  steps: WorkflowStepRecord[];
}

export interface WorkflowPlanStore {
  save(plan: WorkflowPlan): Promise<void>;
  load(id: string): Promise<WorkflowPlan | undefined>;
  list(): Promise<WorkflowPlan[]>;
  delete(id: string): Promise<void>;
  /** Exclusive, fail-closed lock. Stale locks require explicit operator reconciliation. */
  acquireRunLock?(id: string, ownerToken: string): Promise<boolean>;
  releaseRunLock?(id: string, ownerToken: string): Promise<void>;
}

// Serialize replacement of the same plan target across store instances; Windows can reject
// overlapping rename-over-existing-target operations (EPERM).
const saveQueues = new Map<string, Promise<void>>();

function key(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clonePlan(plan: WorkflowPlan): WorkflowPlan {
  return JSON.parse(JSON.stringify(plan)) as WorkflowPlan;
}

function isWorkflowPlan(value: unknown): value is WorkflowPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<WorkflowPlan>;
  if (typeof plan.id !== "string" || !plan.id.trim() || plan.id.length > 256 ||
      typeof plan.title !== "string" || !plan.title.trim() || plan.title.length > 240 ||
      typeof plan.createdAt !== "string" || !Number.isFinite(Date.parse(plan.createdAt)) ||
      typeof plan.updatedAt !== "string" || !Number.isFinite(Date.parse(plan.updatedAt)) ||
      !["draft", "running", "waiting_approval", "completed", "failed", "cancelled"].includes(String(plan.status)) ||
      !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 100) return false;
  const ids = new Set<string>();
  for (const raw of plan.steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const step = raw as unknown as Record<string, unknown>;
    if (typeof step.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(step.id) ||
        ids.has(step.id) || typeof step.title !== "string" || !step.title.trim() || step.title.length > 240 ||
        typeof step.description !== "string" || step.description.length > 4_000 ||
        typeof step.idempotent !== "boolean" || !Array.isArray(step.dependsOn) ||
        step.dependsOn.length > 100 || !step.dependsOn.every((id) => typeof id === "string" && id.length <= 80) ||
        new Set(step.dependsOn).size !== step.dependsOn.length ||
        !["pending", "ready", "running", "waiting_approval", "succeeded", "failed", "skipped", "cancelled"].includes(String(step.status)) ||
        !Number.isSafeInteger(step.attempts) || (step.attempts as number) < 0 || (step.attempts as number) > 10 ||
        (step.risk !== undefined && !["low", "medium", "high"].includes(String(step.risk))) ||
        (step.maxAttempts !== undefined && (!Number.isSafeInteger(step.maxAttempts) || (step.maxAttempts as number) < 1 || (step.maxAttempts as number) > 10)) ||
        !Array.isArray(step.evidenceIds) || step.evidenceIds.length > 256 ||
        !step.evidenceIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) ||
        typeof step.updatedAt !== "string" || !Number.isFinite(Date.parse(step.updatedAt)) ||
        (step.lastError !== undefined && (typeof step.lastError !== "string" || step.lastError.length > 2_000))) return false;
    ids.add(step.id);
  }
  const byId = new Map(plan.steps.map(raw => {
    const step = raw as { id: string; dependsOn: string[] };
    return [step.id, step] as const;
  }));
  for (const raw of plan.steps) {
    const step = raw as { id: string; dependsOn: string[] };
    if (step.dependsOn.some((id) => !ids.has(id) || id === step.id)) return false;
  }
  // Persisted plans are untrusted input too: reject dependency cycles before any
  // caller can schedule a step from a corrupted snapshot.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const step = byId.get(id);
    if (!step) return false;
    visiting.add(id);
    for (const dependency of step.dependsOn) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const id of ids) if (!visit(id)) return false;
  return true;
}

/**
 * Local durable workflow-plan store. IDs are hashed before becoming path components,
 * writes are atomic, and run locks are exclusive and fail closed after a crash.
 */
export class FileWorkflowPlanStore implements WorkflowPlanStore {
  private readonly directory: string;

  constructor(namespace: string, root = sofiaStateDirectory("workflows")) {
    if (typeof namespace !== "string" || !namespace.trim() || namespace.length > 256) {
      throw new Error("Workflow store namespace must be a non-empty string up to 256 characters.");
    }
    if (typeof root !== "string" || !path.isAbsolute(root)) {
      throw new Error("Workflow store root must be an absolute path.");
    }
    this.directory = path.join(root, key(namespace));
  }

  private file(id: string): string {
    if (typeof id !== "string" || !id.trim() || id.length > 256) {
      throw new Error("Workflow ID must be a non-empty string up to 256 characters.");
    }
    return path.join(this.directory, key(id) + ".json");
  }

  private lockFile(id: string): string {
    return this.file(id) + ".lock";
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
  }

  async save(plan: WorkflowPlan): Promise<void> {
    if (!isWorkflowPlan(plan)) throw new Error("Refusing to persist an invalid workflow plan.");
    const target = this.file(plan.id);
    const serialized = JSON.stringify(clonePlan(plan));
    const previous = saveQueues.get(target) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await this.ensureDirectory();
      const temporary = target + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
        if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    saveQueues.set(target, operation);
    try {
      await operation;
    } finally {
      if (saveQueues.get(target) === operation) saveQueues.delete(target);
    }
  }

  async load(id: string): Promise<WorkflowPlan | undefined> {
    try {
      const raw = await fs.readFile(this.file(id), "utf8");
      let value: unknown;
      try { value = JSON.parse(raw) as unknown; }
      catch { throw new Error("Persisted workflow plan contains invalid JSON."); }
      if (!isWorkflowPlan(value)) throw new Error("Persisted workflow plan failed schema validation.");
      if (value.id !== id) throw new Error("Persisted workflow plan ID does not match the requested ID.");
      return clonePlan(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<WorkflowPlan[]> {
    let names: string[];
    try { names = await fs.readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const plans: WorkflowPlan[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const raw = await fs.readFile(path.join(this.directory, name), "utf8");
      let value: unknown;
      try { value = JSON.parse(raw) as unknown; }
      catch { throw new Error("Persisted workflow plan contains invalid JSON."); }
      if (!isWorkflowPlan(value)) throw new Error("Persisted workflow plan failed schema validation.");
      plans.push(clonePlan(value));
    }
    return plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }

  async acquireRunLock(id: string, ownerToken: string): Promise<boolean> {
    if (typeof ownerToken !== "string" || !ownerToken.trim() || ownerToken.length > 256) {
      throw new Error("Workflow lock owner token is invalid.");
    }
    await this.ensureDirectory();
    const file = this.lockFile(id);
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ ownerToken, createdAt: new Date().toISOString() }), "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      // Leave the lock in place if ownership persistence failed: fail closed and require reconciliation.
      throw error;
    }
    await handle.close();
    return true;
  }

  async releaseRunLock(id: string, ownerToken: string): Promise<void> {
    if (typeof ownerToken !== "string" || !ownerToken.trim()) {
      throw new Error("Workflow lock owner token is invalid.");
    }
    const file = this.lockFile(id);
    let raw: string;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let lock: unknown;
    try { lock = JSON.parse(raw) as unknown; }
    catch { throw new Error("Workflow run lock is malformed; refusing to release it automatically."); }
    if (!lock || typeof lock !== "object" ||
        (lock as { ownerToken?: unknown }).ownerToken !== ownerToken) {
      throw new Error("Workflow run lock owner mismatch; refusing to release another owner's lock.");
    }
    await fs.unlink(file);
  }
}
