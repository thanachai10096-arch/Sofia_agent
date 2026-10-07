import { randomUUID } from "node:crypto";
import type { AbortSignal } from "node:abort_controller";
import type { BrainRunInput, BrainRunOptions } from "./executor.js";
import { createSofiaBrain, type SofiaBrain } from "./executor.js";
import type { BrainRunSnapshot } from "./run-state.js";
import type { RunStore } from "./run-store.js";

export interface ManagedRun {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  task: string;
  snapshot?: BrainRunSnapshot;
  result?: Awaited<ReturnType<SofiaBrain["run"]>>;
}

export interface RunManager {
  create(input: Omit<BrainRunInput, "signal" | "resume">): Promise<ManagedRun>;
  get(runId: string): Promise<ManagedRun | undefined>;
  resume(runId: string, signal?: AbortSignal): Promise<ManagedRun>;
  cancel(runId: string): Promise<boolean>;
  list(): Promise<ManagedRun[]>;
}

export class InMemoryRunManager implements RunManager {
  private readonly runs = new Map<string, ManagedRun>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly brainOptions: Omit<BrainRunOptions, "dependencies"> & { dependencies: BrainRunOptions["dependencies"] }, private readonly runStore?: RunStore) {}

  async create(input: Omit<BrainRunInput, "signal" | "resume">): Promise<ManagedRun> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ManagedRun = { id, status: "running", createdAt: now, updatedAt: now, task: input.task };
    this.runs.set(id, record);
    await this.execute(record, input);
    return record;
  }

  async get(runId: string): Promise<ManagedRun | undefined> {
    return this.runs.get(runId);
  }

  async resume(runId: string, signal?: AbortSignal): Promise<ManagedRun> {
    const record = this.runs.get(runId);
    if (!record) throw new Error("Unknown run");
    if (!record.snapshot) throw new Error("Run has no resumable snapshot");
    if (record.status === "completed") return record;

    await this.execute(record, { task: record.task, acceptanceCriteria: record.snapshot.trace.length >= 0 ? undefined : undefined }, signal, record.snapshot);
    return record;
  }

  async cancel(runId: string): Promise<boolean> {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort(new Error("Run cancelled by caller"));
    return true;
  }

  async list(): Promise<ManagedRun[]> {
    return [...this.runs.values()].map((run) => ({ ...run }));
  }

  private async execute(
    record: ManagedRun,
    input: Omit<BrainRunInput, "signal" | "resume">,
    externalSignal?: AbortSignal,
    resume?: BrainRunSnapshot,
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(record.id, controller);

    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
    }

    const onSnapshot = async (snapshot: BrainRunSnapshot) => {
      record.snapshot = snapshot;
      record.updatedAt = new Date().toISOString();
      await this.runStore?.save(snapshot);
    };

    try {
      const brain = createSofiaBrain({
        ...this.brainOptions,
        dependencies: {
          ...this.brainOptions.dependencies,
          onRunSnapshot: onSnapshot,
        },
      });
      const result = await brain.run({ ...input, signal: controller.signal, resume });
      record.result = result;
      record.status = result.completed ? "completed" : result.state === "cancelled" ? "cancelled" : "failed";
      record.updatedAt = new Date().toISOString();
    } finally {
      this.controllers.delete(record.id);
    }
  }
}
