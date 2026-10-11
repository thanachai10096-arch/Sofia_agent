import { randomUUID } from "node:crypto";
import { classifyTask } from "./classifier.js";
import type { AgentDependencies, AgentEvent, AgentRequest, AgentResult } from "./types.js";
import type { ChatMessage, ToolDefinition } from "../models/types.js";
import { assertSafeStep, assertToolAllowed, loadExecutionPolicyFromEnv } from "../security/policy.js";
import { actionHash, riskFor } from "../security/guard.js";
import { validateToolInput } from "../tools/types.js";

export class SofiaAgent {
  constructor(private readonly deps: AgentDependencies) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    // Sofia Brain is the default execution path. Legacy execution is only
    // used when Brain is unavailable or explicitly disabled.
    const shouldUseBrain =
      this.deps.brainFactory !== undefined &&
      request.useBrain !== false;
    if (shouldUseBrain) {
      return this.runBrain(request);
    }

    return this.runLegacy(request);
  }

  private async runBrain(request: AgentRequest): Promise<AgentResult> {
    const kind = classifyTask(request.task);
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent) => {
      events.push(event);
      request.onEvent?.(event);
    };

    const brain = this.deps.brainFactory!({
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.maxSteps !== undefined ? { maxSteps: request.maxSteps } : {}),
    });

    emit({ type: "run.started", message: "Sofia Brain run started." });
    emit({
      type: "task.classified",
      message: `Task classified as ${kind}.`,
      metadata: { kind },
    });

    const report = await brain.run({
      task: request.task,
      ...(request.acceptanceCriteria
        ? { acceptanceCriteria: request.acceptanceCriteria }
        : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!report.completed) {
      emit({
        type: "run.failed",
        message: report.summary,
        metadata: { state: report.state },
      });
      throw new Error(report.summary);
    }

    emit({
      type: "model.completed",
      message: "Sofia Brain completed with verified results.",
      metadata: {
        changedFiles: report.changedFiles,
        verification: report.verification,
        usage: report.usage,
      },
    });

    emit({
      type: "run.completed",
      message: report.summary,
      metadata: {
        changedFiles: report.changedFiles,
        verification: report.verification,
      },
    });

    return {
      runId: brain.runId,
      output: report.summary,
      kind,
      steps: report.usage.steps,
      events,
      brainReport: report,
    };
  }

  private async runLegacy(request: AgentRequest): Promise<AgentResult> {
    const runId = randomUUID();
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent) => {
      events.push(event);
      request.onEvent?.(event);
    };

    emit({ type: "run.started", message: "Sofia run started." });

    const kind = classifyTask(request.task);
    emit({
      type: "task.classified",
      message: `Task classified as ${kind}.`,
      metadata: { kind },
    });

    const policy = this.deps.policy ?? loadExecutionPolicyFromEnv();
    const maxSteps = Math.min(
      request.maxSteps ?? policy.maxSteps,
      policy.maxSteps,
    );

    const messages: ChatMessage[] = [
      {
        role: "system" as const,
        content:
          "You are Sofia. Complete the user's task by reasoning and using tools. Work inside the provided workspace. Do not claim a change was made unless a tool confirms it.",
      },
      { role: "user" as const, content: request.task },
      ...(request.context
        ? [{ role: "user" as const, content: `Workspace context:\n${request.context}` }]
        : []),
    ];

    const toolDefs: ToolDefinition[] = (this.deps.tools?.list() ?? []).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    let lastError: unknown = null;

    for (let step = 1; step <= maxSteps; step += 1) {
      try {
        assertSafeStep(policy, step);
        const route = this.deps.router.select(kind);

        emit({
          type: "model.selected",
          message: "Internal model route selected.",
          step,
        });

        const response = await this.deps.provider.generate(
          {
            task: request.task,
            kind,
            context: request.context,
            step,
            messages,
            tools: toolDefs,
          },
          route,
        );

        if (response.assistantMessage) {
          messages.push(response.assistantMessage);
        }

        emit({
          type: "model.completed",
          message: "Model step completed.",
          step,
        });

        if (response.toolCalls?.length) {
          if (response.toolCalls.length > policy.maxToolCallsPerStep) {
            throw new Error("Too many tool calls requested in one step.");
          }

          for (const call of response.toolCalls) {
            assertToolAllowed(policy, call.name);
            if (!this.deps.tools || !this.deps.runtime) throw new Error("Agent runtime and tool registry are required for tool execution.");
            const tool = this.deps.tools.get(call.name);
            if (!tool) throw new Error(`Unknown tool: ${call.name}`);
            validateToolInput(tool.inputSchema, call.input);

            emit({
              type: "tool.started",
              message: `Running ${call.name}.`,
              step,
              metadata: { tool: call.name },
            });

            if (this.deps.approval) {
              const approved = await this.deps.approval({
                runId,
                principalId: request.principalId,
                toolName: call.name,
                input: call.input,
                actionHash: actionHash(runId, call.name, call.input, request.principalId),
                risk: riskFor([], call.input),
              });

              if (!approved) {
                emit({
                  type: "tool.approval_required",
                  message: `Tool ${call.name} was not approved.`,
                  step,
                  metadata: { tool: call.name },
                });

                messages.push({
                  role: "tool",
                  content: JSON.stringify({ error: "Tool execution not approved" }),
                  toolCallId: call.id,
                });
                continue;
              }
            }

            try {
              const result = await tool.execute(call.input, {
                runtime: this.deps.runtime,
                ...(request.signal ? { signal: request.signal } : {}),
              });
              messages.push({
                role: "tool",
                content: JSON.stringify(result),
                toolCallId: call.id,
              });

              emit({
                type: "tool.completed",
                message: `${call.name} completed.`,
                step,
                metadata: { tool: call.name },
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);

              messages.push({
                role: "tool",
                content: JSON.stringify({ error: message }),
                toolCallId: call.id,
              });

              emit({
                type: "tool.failed",
                message,
                step,
                metadata: { tool: call.name },
              });
            }
          }

          continue;
        }

        if (!response.text.trim()) {
          throw new Error("Agent produced no final response.");
        }

        emit({
          type: "review.started",
          message: "Reviewing model result.",
          step,
        });

        const review = await this.deps.reviewer.review(
          request.task,
          response.text,
        );

        emit({
          type: "review.completed",
          message: review.reason,
          step,
          metadata: { approved: review.approved },
        });

        if (review.approved) {
          emit({ type: "run.completed", message: "Sofia run completed." });
          return {
            runId,
            output: response.text,
            kind,
            steps: step,
            events,
          };
        }

        lastError = new Error(review.reason);
        this.deps.router.markUnhealthy(route.id);
      } catch (error) {
        lastError = error;
        emit({
          type: "retry",
          message: error instanceof Error ? error.message : "Internal step failed.",
          step,
        });
      }
    }

    const message =
      lastError instanceof Error ? lastError.message : "Agent failed";

    emit({ type: "run.failed", message });
    throw new Error(`Sofia failed after ${maxSteps} steps: ${message}`);
  }
}
