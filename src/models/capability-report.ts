import type { ModelFeatureSupport, ModelRoute } from "./types.js";

export type CapabilityValue = boolean | number | "unknown";
export type CapabilitySource = "operator-declared" | "unknown";

export interface ModelCapabilityReport {
  routeId: string;
  capabilities: {
    toolCalling: { value: boolean | "unknown"; source: CapabilitySource };
    vision: { value: boolean | "unknown"; source: CapabilitySource };
    structuredOutput: { value: boolean | "unknown"; source: CapabilitySource };
    contextWindow: { value: number | "unknown"; source: CapabilitySource };
  };
}

/**
 * Report only explicit operator declarations. Model names and provider IDs are
 * deliberately not treated as proof of capability; unknown is safer than guessing.
 * This function performs no network requests and cannot incur provider charges.
 */
export function buildModelCapabilityReport(routes: readonly ModelRoute[]): ModelCapabilityReport[] {
  return routes.map((route) => ({
    routeId: route.id,
    capabilities: {
      toolCalling: capability(route.features, "toolCalling"),
      vision: capability(route.features, "vision"),
      structuredOutput: capability(route.features, "structuredOutput"),
      contextWindow: contextWindow(route.features),
    },
  }));
}

function capability(
  features: ModelFeatureSupport | undefined,
  key: "toolCalling" | "vision" | "structuredOutput",
): ModelCapabilityReport["capabilities"]["vision"] {
  const value = features?.[key];
  return value === undefined
    ? { value: "unknown", source: "unknown" }
    : { value, source: "operator-declared" };
}

function contextWindow(
  features: ModelFeatureSupport | undefined,
): ModelCapabilityReport["capabilities"]["contextWindow"] {
  const value = features?.contextWindow;
  return value === undefined
    ? { value: "unknown", source: "unknown" }
    : { value, source: "operator-declared" };
}
