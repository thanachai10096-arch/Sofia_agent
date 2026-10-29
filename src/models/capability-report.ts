import type { ModelRoute } from "./types.js";

export type DeclaredCapability = boolean | number | "unknown";

export interface ModelCapabilityReportEntry {
  routeId: string;
  providerId: string;
  model: string;
  toolCalling: boolean | "unknown";
  vision: boolean | "unknown";
  structuredOutput: boolean | "unknown";
  contextWindow: number | "unknown";
}

/**
 * Report only operator-declared metadata. This function does not infer support
 * from model names or contact providers, and it never includes credentials.
 */
export function buildModelCapabilityReport(
  routes: readonly ModelRoute[],
): ModelCapabilityReportEntry[] {
  return routes.map((route) => ({
    routeId: route.id,
    providerId: route.providerId ?? route.id,
    model: route.model ?? "unknown",
    toolCalling: route.featureSupport?.toolCalling ?? "unknown",
    vision: route.featureSupport?.vision ?? "unknown",
    structuredOutput: route.featureSupport?.structuredOutput ?? "unknown",
    contextWindow: route.featureSupport?.contextWindow ?? "unknown",
  }));
}
