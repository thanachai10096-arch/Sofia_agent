import type { IncomingMessage, ServerResponse } from "node:http";

export interface WhatsAppWebhookRouteTransport {
  verifyChallenge(input: { mode: string | undefined; token: string | undefined; challenge: string | undefined }): string | undefined;
  handleWebhook(rawBody: Uint8Array, signature: string | undefined): Promise<{ status: 200 | 400 | 401 | 413 | 503; acceptedEvents: number }>;
}

/** Node HTTP route helper for Meta's GET challenge and signed POST webhook. */
export async function handleWhatsAppWebhookHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: WhatsAppWebhookRouteTransport,
  maxBodyBytes = 1_000_000,
): Promise<void> {
  const respondJson = (status: number, body: Record<string, number | string>, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET") {
    const challenge = transport.verifyChallenge({
      mode: url.searchParams.get("hub.mode") ?? undefined,
      token: url.searchParams.get("hub.verify_token") ?? undefined,
      challenge: url.searchParams.get("hub.challenge") ?? undefined,
    });
    if (challenge === undefined) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end("Forbidden");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(challenge);
    return;
  }
  if (req.method !== "POST") {
    respondJson(405, { error: "method_not_allowed" }, { allow: "GET, POST" });
    return;
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1_000_000) {
    respondJson(500, { error: "invalid_route_configuration" });
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
    respondJson(400, { error: "invalid_request_body" });
    return;
  }
  if (oversized) {
    respondJson(413, { error: "request_too_large" }, { connection: "close" });
    return;
  }
  const header = req.headers["x-hub-signature-256"];
  try {
    const result = await transport.handleWebhook(Buffer.concat(chunks), typeof header === "string" ? header : undefined);
    respondJson(result.status, { acceptedEvents: result.acceptedEvents });
  } catch {
    if (!res.headersSent) respondJson(503, { error: "messaging_transport_unavailable" });
    else res.destroy();
  }
}
