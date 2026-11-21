import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Deployment smoke endpoint only.
 *
 * This deliberately does not initialize Sofia Core: the current Core composition
 * root uses filesystem-backed stores and process-owned timers, neither of which
 * is safe to treat as durable state in a Vercel Function.
 */
export default function handler(_request: IncomingMessage, response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify({
    service: "sofia-agent",
    status: "degraded",
    checks: {
      httpFunction: "ok",
      coreRuntime: "not_connected",
      durableStorage: "not_configured",
      durableWorkflow: "not_configured",
    },
    message: "Vercel function is reachable; Sofia Core is not yet enabled on this deployment.",
  }));
}
