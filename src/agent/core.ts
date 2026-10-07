import { randomUUID } from "node:crypto";
import { classifyTask } from "./classifier.js";
import type { AgentDependencies, AgentEvent, AgentRequest, AgentResult } from "./types.js";
import { assertSafeStep, defaultPolicy } from "../security/policy.js";

export class SofiaAgent {
  constructor(private readonly deps: AgentDependencies) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const runId = randomUUID();
    const events: AgentEvent[] = [
      { type: "run.started", message: "Sofia run started." },
    ];

    const kind = classifyTask(request.task);
    events.push({
      type: "task.classified",
      message: `Task classified as ${kind}.`,
      metadata: { kind },
    });

    let lastError: unknown = null;
    const maxSteps = Math.min(request.maxSteps ?? defaultPolicy.maxSteps, defaultPolicy.maxSteps);

    for (let attempt = 0; attempt < Math.min(3, maxSteps); attempt++) {
      try {
        assertSafeStep(defaultPolicy, attempt + 1);
        const route = this.deps.router.select(kind);

        // Route identity is deliberately internal. It never appears in AgentResult.
        events.push({
          type: "model.selected",
          message: "Internal model route selected.",
          step: attempt + 1,
        });

        const modelRequest = {
          task: request.task,
          kind,
          ...(request.context ? { context: request.context } : {}),
          step: attempt + 1,
        };
        const response = await this.deps.provider.generate(modelRequest, route);

        events.push({
          type: "model.completed",
          message: "Model step completed.",
          step: attempt + 1,
        });

        events.push({
          type: "review.started",
          message: "Reviewing model result.",
          step: attempt + 1,
        });

        const review = await this.deps.reviewer.review(request.task, response.text);

        events.push({
          type: "review.completed",
          message: review.reason,
          step: attempt + 1,
          metadata: { approved: review.approved },
        });

        if (review.approved) {
          events.push({ type: "run.completed", message: "Sofia run completed." });
          return {
            runId,
            output: response.text,
            kind,
            steps: attempt + 1,
            events,
          };
        }

        lastError = new Error(review.reason);
        if (attempt < 2) {
          this.deps.router.markUnhealthy(route.id);
          events.push({
            type: "retry",
            message: "Result rejected; escalating to another internal route.",
            step: attempt + 1,
          });
        }
      } catch (error) {
        lastError = error;
        events.push({
          type: "retry",
          message: "Internal model step failed; attempting fallback.",
          step: attempt + 1,
        });
      }
    }

    const message = lastError instanceof Error ? lastError.message : "Agent failed";
    events.push({ type: "run.failed", message });
    throw new Error(`Sofia failed after fallback attempts: ${message}`);
  }
}
