/**
 * Vercel function smoke-test endpoint.
 *
 * This endpoint verifies that Vercel can route an HTTP request to a Node
 * Function. It deliberately does not claim that the Sofia Core, durable
 * storage, or background execution is ready.
 */
interface HealthRequest {
  method?: string;
}

interface HealthResponse {
  setHeader(name: string, value: string): void;
  status(code: number): HealthResponse;
  json(body: unknown): void;
}

export default function handler(request: HealthRequest, response: HealthResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    response.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  response.status(200).json({
    ok: true,
    service: "sofia-agent-vercel-smoke-test",
    deployment: "serverless-function-reachable",
    sofiaCore: "not_connected",
    durableStorage: "not_configured",
    durableExecution: "not_configured",
    productionReady: false,
  });
}
