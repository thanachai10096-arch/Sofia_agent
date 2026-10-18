import { randomUUID } from "node:crypto";
import { BoundedSubagentCoordinator, type SubagentCoordinatorOptions } from "./subagent-coordinator.js";
import type { SubagentRequest, SubagentResult, SubagentRuntime } from "./subagents.js";

/**
 * Adapts the Brain's single-task SubagentRuntime contract to the bounded coordinator.
 * This preserves existing Brain delegation semantics while applying task-count,
 * context-size, concurrency, cancellation, and timeout limits to every delegated run.
 */
export class CoordinatedSubagentRuntime implements SubagentRuntime {
  private readonly coordinator: BoundedSubagentCoordinator;

  constructor(runtime: SubagentRuntime, options: SubagentCoordinatorOptions = {}) {
    this.coordinator = new BoundedSubagentCoordinator(
      () => runtime,
      options,
    );
  }

  async run(request: SubagentRequest): Promise<SubagentResult> {
    const items = await this.coordinator.runMany([{
      id: randomUUID(),
      role: request.role,
      task: request.task,
      ...(request.context ? { context: request.context } : {}),
    }], request.signal);
    const item = items[0];
    if (!item) throw new Error("Subagent coordinator returned no result");
    if (item.error) throw new Error(item.error);
    if (!item.result) throw new Error("Subagent coordinator returned an empty result");
    return item.result;
  }
}
