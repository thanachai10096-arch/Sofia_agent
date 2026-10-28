import type { IncomingMessage, ServerResponse } from "node:http";
import type { WhatsAppWebhookTransport } from "./whatsapp-webhook-transport.js";

/** Bounded Meta webhook route supporting both GET verification and signed POST events. */
export async function handleWhatsAppWebhookHttpRequest(
  req: IncomingMessage, res: ServerResponse, transport: WhatsAppWebhookTransport, requestUrl: string, maxBodyBytes = 1_000_000,
): Promise<void> {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { ...headers, allow: "GET, POST" }); res.end(JSON.stringify({ error: "method_not_allowed" })); return;
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1_000_000) {
    res.writeHead(500, headers); res.end(JSON.stringify({ error: "invalid_route_configuration" })); return;
  }
  const url = new URL(requestUrl, "http://localhost");
  if (req.method === "GET") {
    const result = await transport.handleRequest({
      method: "GET", headers: {}, rawBody: new Uint8Array(),
      query: { mode: url.searchParams.get("hub.mode") ?? undefined,
        verifyToken: url.searchParams.get("hub.verify_token") ?? undefined,
        challenge: url.searchParams.get("hub.challenge") ?? undefined },
    });
    res.writeHead(result.status, { ...headers, "content-type": result.contentType ?? headers["content-type"] });
    res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body)); return;
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
    res.writeHead(400, headers); res.end(JSON.stringify({ error: "invalid_request_body" })); return;
  }
  if (oversized) {
    res.writeHead(413, { ...headers, connection: "close" }); res.end(JSON.stringify({ error: "request_too_large" })); return;
  }
  try {
    const signature = req.headers["x-hub-signature-256"];
    const result = await transport.handleRequest({
      method: "POST",
      headers: { "x-hub-signature-256": typeof signature === "string" ? signature : undefined },
      rawBody: Buffer.concat(chunks),
    });
    res.writeHead(result.status, { ...headers, "content-type": result.contentType ?? headers["content-type"] });
    res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
  } catch {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(503, headers); res.end(JSON.stringify({ error: "messaging_transport_unavailable" }));
  }
}
