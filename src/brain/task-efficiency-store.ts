import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TaskMeasurement } from "./task-efficiency-metrics.js";
import { sofiaStateDirectory } from "../platform/state-directory.js";

const appendQueues = new Map<string, Promise<void>>();

/** Optional durable sink for aggregate telemetry; prompts and model output are never accepted. */
export class FileTaskEfficiencyStore {
  private readonly filePath: string;

  constructor(workspace: string, principalId: string, root = sofiaStateDirectory("efficiency")) {
    if (!workspace.trim() || !principalId.trim()) throw new Error("Efficiency telemetry namespace is required");
    const namespace = createHash("sha256").update(workspace).update("\0").update(principalId).digest("hex");
    this.filePath = path.join(root, namespace + ".jsonl");
  }

  private sanitize(value: TaskMeasurement): TaskMeasurement {
    if (!value || typeof value !== "object" || typeof value.taskId !== "string" || !value.taskId.trim()) {
      throw new Error("Invalid efficiency measurement");
    }
    for (const [key, count] of [
      ["acceptance criteria", value.acceptanceCriteria],
      ["passed criteria", value.passedCriteria],
      ["input tokens", value.inputTokens],
      ["output tokens", value.outputTokens],
      ["cached input tokens", value.cachedInputTokens],
      ["model calls", value.modelCalls],
      ["retries", value.retries],
      ["duration", value.durationMs],
    ] as const) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid telemetry " + key);
    }
    if (value.passedCriteria > value.acceptanceCriteria || value.cachedInputTokens > value.inputTokens ||
        typeof value.completed !== "boolean" || typeof value.costKnown !== "boolean") {
      throw new Error("Invalid efficiency measurement");
    }
    const clean: TaskMeasurement = {
      taskId: value.taskId, completed: value.completed,
      acceptanceCriteria: value.acceptanceCriteria, passedCriteria: value.passedCriteria,
      inputTokens: value.inputTokens, outputTokens: value.outputTokens,
      cachedInputTokens: value.cachedInputTokens, modelCalls: value.modelCalls,
      retries: value.retries, durationMs: value.durationMs, costKnown: value.costKnown,
    };
    if (value.estimatedCostNanoUsd !== undefined) {
      if (!/^\d+$/.test(value.estimatedCostNanoUsd)) throw new Error("Invalid estimated cost");
      clean.estimatedCostNanoUsd = value.estimatedCostNanoUsd;
    }
    if (value.costPerVerifiedSuccessNanoUsd !== undefined) {
      if (!/^\d+$/.test(value.costPerVerifiedSuccessNanoUsd)) throw new Error("Invalid verified-success cost");
      clean.costPerVerifiedSuccessNanoUsd = value.costPerVerifiedSuccessNanoUsd;
    }
    return clean;
  }

  async append(value: TaskMeasurement): Promise<void> {
    const record = JSON.stringify(this.sanitize(value)) + "\n";
    const previous = appendQueues.get(this.filePath) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await fs.chmod(path.dirname(this.filePath), 0o700);
      const handle = await fs.open(this.filePath, "a", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(record, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    appendQueues.set(this.filePath, operation);
    try { await operation; }
    finally { if (appendQueues.get(this.filePath) === operation) appendQueues.delete(this.filePath); }
  }

  async readAll(): Promise<TaskMeasurement[]> {
    let content: string;
    try { content = await fs.readFile(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return content.split("\n").filter(Boolean).map((line) => this.sanitize(JSON.parse(line) as TaskMeasurement));
  }
}
