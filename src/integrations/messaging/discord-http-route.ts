import type { IncomingMessage, ServerResponse } from "node:http";
import type { DiscordInteractionTransportOptions } from "./discord-interaction-transport.js";
import type { createDiscordInteractionTransport } from "./discord-interaction-transport.js";

type DiscordInteractionTransport = ReturnType<typeof createDiscordInteractionTransport>;

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
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > maxBodyBytes) {
        // Drain the remainder so the connection can be reused; never parse oversized input.
        req.resume();
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "request_too_large" }));
        return;
      }
      chunks.push(bytes);
    }
  } catch {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "invalid_request_body" }));
    return;
  }

  const signatureHeader = req.headers["x-signature-ed25519"];
  const timestampHeader = req.headers["x-signature-timestamp"];
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
}
