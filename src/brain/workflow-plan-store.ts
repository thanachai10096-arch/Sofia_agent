import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WorkflowPlan } from "./workflow-plan.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";

export interface WorkflowPlanStore {
  save(plan: WorkflowPlan): Promise<void>;
  load(id: string): Promise<WorkflowPlan | undefined>;
  list(): Promise<WorkflowPlan[]>;
  delete(id: string): Promise<void>;
  /** Atomic cross-process claim when supported by the backing store. */
  acquireRunLock?(id: string, ownerToken: string): Promise<boolean>;
  /** Releases only a lock owned by this caller. */
  releaseRunLock?(id: string, ownerToken: string): Promise<void>;
}

const writeQueues = new Map<string, Promise<void>>();
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function isWorkflowPlan(value: unknown): value is WorkflowPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<WorkflowPlan>;
  if (typeof plan.id !== "string" || !plan.id || typeof plan.title !== "string" ||
      typeof plan.createdAt !== "string" || typeof plan.updatedAt !== "string" ||
      !["draft", "running", "waiting_approval", "completed", "failed", "cancelled"].includes(String(plan.status)) ||
      !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 100) return false;
  const ids = new Set<string>();
  for (const raw of plan.steps) {
    if (!raw || typeof raw !== "object") return false;
    const step = raw as Partial<WorkflowPlan["steps"][number]>;
    if (typeof step.id !== "string" || !step.id || ids.has(step.id) ||
        typeof step.title !== "string" || typeof step.description !== "string" ||
        typeof step.idempotent !== "boolean" || !Array.isArray(step.dependsOn) ||
        !step.dependsOn.every((id) => typeof id === "string") ||
        !["pending", "ready", "running", "waiting_approval", "succeeded", "failed", "skipped", "cancelled"].includes(String(step.status)) ||
        !Number.isInteger(step.attempts) || (step.attempts ?? -1) < 0 ||
        !Array.isArray(step.evidenceIds) || !step.evidenceIds.every((id) => typeof id === "string") ||
        typeof step.updatedAt !== "string" ||
        (step.consequential !== undefined && typeof step.consequential !== "boolean") ||
        (step.risk !== undefined && !["low", "medium", "high"].includes(String(step.risk))) ||
        (step.action !== undefined && (!step.action || typeof step.action.tool !== "string" || !step.action.tool.trim() || !step.action.input || typeof step.action.input !== "object" || Array.isArray(step.action.input)))) return false;
    ids.add(step.id);
  }
  return plan.steps.every((step) => step.dependsOn.every((id) => ids.has(id)));
}

/** Local durable plan store. Use a transactional shared store for multi-process workers. */
export class FileWorkflowPlanStore implements WorkflowPlanStore {
  private readonly directory: string;

  constructor(namespace: string, root = sofiaStateDirectory("workflows")) {
    if (!namespace.trim()) throw new Error("Workflow store namespace must not be empty");
    this.directory = path.join(root, digest(namespace));
  }

  private file(id: string): string {
    if (typeof id !== "string" || !id.trim()) throw new Error("Workflow plan id must not be empty");
    return path.join(this.directory, digest(id) + ".json");
  }

  private lockDirectory(id: string): string {
    return this.file(id) + ".run-lock";
  }

  /**
   * Atomic mkdir provides a local-filesystem cross-process claim. A crashed process
   * leaves the lock in place intentionally: operators must reconcile side effects
   * before removing it, rather than risk a lease expiry causing duplicate execution.
   */
  async acquireRunLock(id: string, ownerToken: string): Promise<boolean> {
    if (typeof ownerToken !== "string" || !ownerToken.trim()) throw new Error("Run lock owner token must not be empty");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const lock = this.lockDirectory(id);
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      await fs.writeFile(path.join(lock, "owner"), ownerToken, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return true;
    } catch (error) {
      await fs.rm(lock, { recursive: true, force: true });
      throw error;
    }
  }

  async releaseRunLock(id: string, ownerToken: string): Promise<void> {
    const lock = this.lockDirectory(id);
    let actual: string;
    try {
      actual = await fs.readFile(path.join(lock, "owner"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (actual !== ownerToken) throw new Error("Cannot release a workflow run lock owned by another process");
    await fs.rm(lock, { recursive: true, force: true });
  }

  async save(plan: WorkflowPlan): Promise<void> {
    if (!isWorkflowPlan(plan)) throw new Error("Invalid workflow plan; refusing to persist malformed state");
    const target = this.file(plan.id);
    const previous = writeQueues.get(target) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await fs.chmod(this.directory, 0o700);
      const temporary = target + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(temporary, JSON.stringify(plan), { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    writeQueues.set(target, operation);
    try {
      await operation;
    } finally {
      if (writeQueues.get(target) === operation) writeQueues.delete(target);
    }
  }

  async load(id: string): Promise<WorkflowPlan | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file(id), "utf8"));
      if (!isWorkflowPlan(parsed)) throw new Error("Persisted workflow plan is malformed");
      if (parsed.id !== id) throw new Error("Persisted workflow plan identity mismatch");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<WorkflowPlan[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const plans: WorkflowPlan[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8"));
      if (!isWorkflowPlan(parsed)) throw new Error("Persisted workflow plan is malformed");
      if (this.file(parsed.id) !== path.join(this.directory, name)) {
        throw new Error("Persisted workflow plan identity mismatch");
      }
      plans.push(parsed);
    }
    return plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<void> {
    let locked = false;
    try {
      await fs.access(this.lockDirectory(id));
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (locked) throw new Error("Cannot delete a workflow with an active or unreconciled run lock");
    try {
      await fs.unlink(this.file(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
