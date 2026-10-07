import type { AgentEvent } from "../agent/types.js";
import type { SofiaProgress } from "./types.js";

export function progressFromAgentEvent(event: AgentEvent): SofiaProgress | undefined {
  switch (event.type) {
    case "run.started":
      return { phase: "understand", title: "Sofia is getting started." };
    case "task.classified":
      return { phase: "understand", title: "Sofia is understanding what you want." };
    case "model.selected":
      return { phase: "plan", title: "Sofia is choosing the best approach." };
    case "tool.started":
      return toolProgress(event.metadata?.tool as string | undefined);
    case "tool.failed":
      return {
        phase: "repair",
        title: "Sofia found a problem and is working on a fix.",
        technical: event.message,
      };
    case "review.started":
      return { phase: "review", title: "Sofia is checking the result." };
    case "review.completed":
      return event.metadata?.approved === false
        ? { phase: "repair", title: "Sofia is improving the result." }
        : { phase: "review", title: "Sofia finished checking the result." };
    case "retry":
      return { phase: "repair", title: "Sofia is trying another approach." };
    case "run.completed":
      return { phase: "done", title: "Done. Sofia verified the result." };
    case "run.failed":
      return { phase: "blocked", title: "Sofia could not finish safely.", detail: event.message };
    default:
      return undefined;
  }
}

function toolProgress(tool?: string): SofiaProgress {
  if (!tool) return { phase: "build", title: "Sofia is working on your project." };

  if (/test|verify|check/i.test(tool)) {
    return { phase: "test", title: "Sofia is testing the changes." };
  }
  if (/write|patch|edit|create|delete/i.test(tool)) {
    return { phase: "build", title: "Sofia is making the changes." };
  }
  if (/read|list|search|diff/i.test(tool)) {
    return { phase: "understand", title: "Sofia is inspecting the project." };
  }

  return { phase: "build", title: "Sofia is working on your project." };
}
