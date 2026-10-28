import type { IncomingMessage, ServerResponse } from "node:http";
import type { SlackEventsTransport } from "./slack-events-transport.js";

/** Mount Slack Events API on Sofia's existing HTTP server, preserving raw request bytes. */
export async function handleSlackEventsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: SlackEventsTransport,
  maxBodyBytes = 1_000_000,
): Promise<void> {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (req.method !== "POST") {
    res.writeHead(405, { ...headers, allow: "POST" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1_000_000) {
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: "invalid_route_configuration" }));
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > maxBodyBytes) { oversized = true; continue; }
      if (!oversized) chunks.push(bytes);
    }
  } catch {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ error: "invalid_request_body" }));
    return;
  }
  if (oversized) {
    res.writeHead(413, { ...headers, connection: "close" });
    res.end(JSON.stringify({ error: "request_too_large" }));
    return;
  }
  try {
    const signature = req.headers["x-slack-signature"];
    const timestamp = req.headers["x-slack-request-timestamp"];
    const result = await transport.handleRequest({
      headers: {
        "x-slack-signature": typeof signature === "string" ? signature : undefined,
        "x-slack-request-timestamp": typeof timestamp === "string" ? timestamp : undefined,
      },
      rawBody: Buffer.concat(chunks),
    });
    res.writeHead(result.status, headers);
    res.end(JSON.stringify(result.body));
  } catch {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(503, headers);
    res.end(JSON.stringify({ error: "messaging_transport_unavailable" }));
  }
}
