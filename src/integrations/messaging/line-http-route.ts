import type { IncomingMessage, ServerResponse } from "node:http";
export interface LineWebhookTransport {
  handleWebhook(rawBody: Uint8Array, signature: string | undefined): Promise<{ status: 200 | 400 | 401 | 413 | 503; acceptedEvents: number }>;
}

/** Node HTTP helper for a configured LINE webhook path; preserves exact raw body for signature verification. */
export async function handleLineWebhookHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: LineWebhookTransport,
  maxBodyBytes = 1_000_000,
): Promise<void> {
  const respond = (status: number, body: Record<string, number | string>, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") {
    respond(405, { error: "method_not_allowed" }, { allow: "POST" });
    return;
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1_000_000) {
    respond(500, { error: "invalid_route_configuration" });
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
    respond(400, { error: "invalid_request_body" });
    return;
  }
  if (oversized) {
    respond(413, { error: "request_too_large" }, { connection: "close" });
    return;
  }
  const header = req.headers["x-line-signature"];
  try {
    const result = await transport.handleWebhook(
      Buffer.concat(chunks),
      typeof header === "string" ? header : undefined,
    );
    respond(result.status, { acceptedEvents: result.acceptedEvents });
  } catch {
    if (!res.headersSent) respond(503, { error: "messaging_transport_unavailable" });
    else res.destroy();
  }
}
