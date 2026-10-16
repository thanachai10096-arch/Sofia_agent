import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sofiaStateDirectory } from "../platform/state-directory.js";

export type WorkflowJournalStatus = "started" | "completed" | "failed";

export interface WorkflowJournalEntry {
  workflowId: string;
  stepId: string;
  actionHash: string;
  status: WorkflowJournalStatus;
  evidenceIds: string[];
  updatedAt: string;
  error?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isEntry(value: unknown): value is WorkflowJournalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<WorkflowJournalEntry>;
  return typeof entry.workflowId === "string" && entry.workflowId.length > 0 &&
    typeof entry.stepId === "string" && entry.stepId.length > 0 &&
    typeof entry.actionHash === "string" && /^[a-f0-9]{64}$/.test(entry.actionHash) &&
    ["started", "completed", "failed"].includes(String(entry.status)) &&
    Array.isArray(entry.evidenceIds) && entry.evidenceIds.length <= 100 &&
    entry.evidenceIds.every((id) => typeof id === "string" && id.length <= 500) &&
    typeof entry.updatedAt === "string" &&
    (entry.error === undefined || (typeof entry.error === "string" && entry.error.length <= 1000));
}

/**
 * Local durable journal for tool actions. A completed entry can reconcile a crash
 * between tool completion and plan persistence. A started/failed/missing entry is
 * deliberately ambiguous and must never authorize automatic replay.
 */
export class FileWorkflowExecutionJournal {
  private readonly directory: string;

  constructor(namespace: string, root = sofiaStateDirectory("workflow-journal")) {
    if (!namespace.trim()) throw new Error("Workflow journal namespace must not be empty");
    this.directory = path.join(root, digest(namespace));
  }

  private file(workflowId: string, stepId: string): string {
    if (!workflowId.trim() || !stepId.trim()) throw new Error("Workflow journal identity must not be empty");
    return path.join(this.directory, digest(workflowId + "\n" + stepId) + ".json");
  }

  private async write(entry: WorkflowJournalEntry): Promise<void> {
    if (!isEntry(entry)) throw new Error("Invalid workflow journal entry");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const target = this.file(entry.workflowId, entry.stepId);
    const temporary = target + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async get(workflowId: string, stepId: string): Promise<WorkflowJournalEntry | undefined> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.file(workflowId, stepId), "utf8"));
      if (!isEntry(value)) throw new Error("Persisted workflow journal entry is malformed");
      if (value.workflowId !== workflowId || value.stepId !== stepId) {
        throw new Error("Persisted workflow journal identity mismatch");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async recordStarted(input: { workflowId: string; stepId: string; actionHash: string }): Promise<void> {
    const existing = await this.get(input.workflowId, input.stepId);
    if (existing) {
      throw new Error("A workflow action journal entry already exists; reconcile it or create an explicit retry plan.");
    }
    await this.write({ ...input, status: "started", evidenceIds: [], updatedAt: new Date().toISOString() });
  }

  async recordCompleted(input: { workflowId: string; stepId: string; actionHash: string; evidenceIds?: readonly string[] }): Promise<void> {
    const existing = await this.get(input.workflowId, input.stepId);
    if (!existing || existing.status !== "started" || existing.actionHash !== input.actionHash) {
      throw new Error("Cannot mark a workflow action completed without its matching started journal entry.");
    }
    await this.write({
      workflowId: input.workflowId,
      stepId: input.stepId,
      actionHash: input.actionHash,
      status: "completed",
      evidenceIds: [...new Set(input.evidenceIds ?? [])].slice(-100),
      updatedAt: new Date().toISOString(),
    });
  }

  async recordFailed(input: { workflowId: string; stepId: string; actionHash: string; error: string }): Promise<void> {
    const existing = await this.get(input.workflowId, input.stepId);
    if (!existing || existing.status !== "started" || existing.actionHash !== input.actionHash) {
      throw new Error("Cannot mark a workflow action failed without its matching started journal entry.");
    }
    await this.write({
      workflowId: input.workflowId,
      stepId: input.stepId,
      actionHash: input.actionHash,
      status: "failed",
      evidenceIds: [],
      error: input.error.slice(0, 1000),
      updatedAt: new Date().toISOString(),
    });
  }
}
