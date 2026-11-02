import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSofiaVercelRequest } from "../../src/platform/vercel-api-runtime.js";

export const config = {
  api: { bodyParser: false },
};

export default function sofiaCoreRoute(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  try {
    handleSofiaVercelRequest(request, response);
  } catch {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ error: "sofia_core_unavailable" }));
  }
}
