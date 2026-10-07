import type { ModelRoute, TaskKind } from "./types.js";

const capabilityFor: Record<TaskKind, string[]> = {
  coding: ["coding", "tool-use", "reasoning"],
  debugging: ["coding", "tool-use", "reasoning"],
  research: ["reasoning", "long-context", "tool-use"],
  analysis: ["reasoning", "long-context"],
  vision: ["vision", "reasoning"],
  general: ["fast"],
};

export class ModelRouter {
  constructor(private readonly routes: ModelRoute[]) {}

  select(kind: TaskKind): ModelRoute {
    const required = capabilityFor[kind];

    const candidates = this.routes
      .filter((route) => route.healthy)
      .map((route) => {
        const capabilityScore = required.reduce(
          (score, capability) => score + (route.capabilities.includes(capability as never) ? 3 : 0),
          0,
        );

        const score =
          capabilityScore +
          route.qualityWeight * 0.8 -
          route.costWeight * 0.2 -
          route.latencyWeight * 0.15;

        return { route, score };
      })
      .sort((a, b) => b.score - a.score);

    const winner = candidates[0]?.route;
    if (!winner) throw new Error("No healthy model route is available");
    return winner;
  }

  markUnhealthy(id: string): void {
    const route = this.routes.find((item) => item.id === id);
    if (route) route.healthy = false;
  }
}
