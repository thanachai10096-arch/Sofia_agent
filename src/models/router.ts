import type { ModelRoute, TaskKind } from "./types.js";

const capabilityFor: Record<TaskKind, string[]> = {
  coding: ["coding", "tool-use", "reasoning"],
  debugging: ["coding", "tool-use", "reasoning"],
  research: ["reasoning", "long-context", "tool-use"],
  analysis: ["reasoning", "long-context"],
  vision: ["vision", "reasoning"],
  general: ["fast"],
};

function cloneRoute(route: ModelRoute): ModelRoute {
  return { ...route, capabilities: [...route.capabilities] };
}

export class ModelRouter {
  private readonly routes: ModelRoute[];
  private readonly winners = new Map<TaskKind, ModelRoute>();

  constructor(routes: ModelRoute[]) {
    // Own a defensive snapshot: callers must not be able to mutate routing policy
    // after the router has scored its candidates.
    this.routes = routes.map(cloneRoute);
    this.rebuild();
  }

  private rebuild(): void {
    this.winners.clear();
    for (const kind of Object.keys(capabilityFor) as TaskKind[]) {
      const required = capabilityFor[kind];
      let winner: ModelRoute | undefined;
      let best = -Infinity;
      for (const route of this.routes) {
        if (!route.healthy) continue;
        let capabilityScore = 0;
        for (const capability of required) {
          if (route.capabilities.includes(capability as never)) capabilityScore += 3;
        }
        const score =
          capabilityScore +
          route.qualityWeight * 0.8 -
          route.costWeight * 0.2 -
          route.latencyWeight * 0.15;
        if (score > best) {
          best = score;
          winner = route;
        }
      }
      if (winner) this.winners.set(kind, winner);
    }
  }

  listRoutes(): ModelRoute[] {
    return this.routes.map(cloneRoute);
  }

  select(kind: TaskKind, preferredRouteId?: string): ModelRoute {
    if (preferredRouteId && preferredRouteId !== "auto") {
      const preferred = this.routes.find((route) => route.id === preferredRouteId);
      if (!preferred) throw new Error("Unknown model route: " + preferredRouteId);
      if (!preferred.healthy) throw new Error("Requested model route is unhealthy: " + preferredRouteId);
      return cloneRoute(preferred);
    }
    const winner = this.winners.get(kind);
    if (!winner || !winner.healthy) this.rebuild();
    const route = this.winners.get(kind);
    if (!route) throw new Error("No healthy model route is available");
    return cloneRoute(route);
  }

  markUnhealthy(id: string): void {
    const route = this.routes.find((item) => item.id === id);
    if (route) {
      route.healthy = false;
      this.rebuild();
    }
  }
}
