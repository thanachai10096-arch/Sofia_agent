import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Platform-level health check for the Vercel Preview deployment.
 * This intentionally does not claim that the Sofia Agent Core or model
 * provider is ready; those require separate runtime checks.
 */
export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({
    status: "ok",
    service: "sofia-vercel-adapter",
    core: "not-probed",
  }));
}
