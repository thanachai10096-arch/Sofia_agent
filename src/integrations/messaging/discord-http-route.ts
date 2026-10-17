import type { IncomingMessage, ServerResponse } from "node:http";
import type { DiscordInteractionTransport } from "./discord-interaction-transport.js";

/**
 * Node HTTP route helper for an existing HTTPS server. Call this only for the
 * exact configured Discord interactions path; preserve the request bytes and
 * do not run a JSON body parser before this function.
 */
export async function handleDiscordInteractionHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: DiscordInteractionTransport,
  maxBodyBytes = 1_000_000,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1_000_000) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
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
      if (size > maxBodyBytes) {
        oversized = true;
        continue;
      }
      if (!oversized) chunks.push(bytes);
    }
  } catch {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "invalid_request_body" }));
    return;
  }
  if (oversized) {
    res.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", connection: "close" });
    res.end(JSON.stringify({ error: "request_too_large" }));
    return;
  }

  const signatureHeader = req.headers["x-signature-ed25519"];
  const timestampHeader = req.headers["x-signature-timestamp"];
  try {
    const result = await transport.handleRequest({
      headers: {
        "x-signature-ed25519": typeof signatureHeader === "string" ? signatureHeader : undefined,
        "x-signature-timestamp": typeof timestampHeader === "string" ? timestampHeader : undefined,
      },
      rawBody: Buffer.concat(chunks),
    });
    res.writeHead(result.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(result.body));
  } catch {
    // Never leak transport exceptions, tokens, or request contents to clients.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify({ error: "messaging_transport_unavailable" }));
  }
}
