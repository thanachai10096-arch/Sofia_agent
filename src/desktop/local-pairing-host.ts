import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DesktopPairingAuthority } from "./pairing.js";
import type { DesktopCapability } from "./types.js";

export interface LocalPairingHostConfig {
  allowedCapabilities: readonly DesktopCapability[];
  onPairingCode: (code: string, expiresAt: number) => void;
}
export interface LocalPairingHost {
  url: string;
  close(): Promise<void>;
  revokeAll(): void;
}

/** Pairing-only loopback transport. It intentionally exposes no desktop actions. */
export async function startLocalPairingHost(config: LocalPairingHostConfig): Promise<LocalPairingHost> {
  const authority = new DesktopPairingAuthority({ allowedCapabilities: config.allowedCapabilities });
  let port = 0;
  const server = createServer(async (req, res) => {
    const host = req.headers.host?.toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, { "cache-control": "no-store" }).end();
      return;
    }
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname) || origin.port !== String(port)) {
          res.writeHead(403, { "cache-control": "no-store" }).end();
          return;
        }
      } catch {
        res.writeHead(403, { "cache-control": "no-store" }).end();
        return;
      }
    }
    if (req.method !== "POST" || req.url !== "/pair") {
      res.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += chunk.length;
        if (size > 4096) throw new Error("Pairing request too large.");
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid pairing request.");
      const data = body as { code?: unknown; capabilities?: unknown };
      if (typeof data.code !== "string") throw new Error("Pairing code is required.");
      const capabilities = data.capabilities ?? [];
      if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== "string")) throw new Error("Capabilities must be strings.");
      const session = authority.pair(data.code, capabilities as DesktopCapability[]);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      }).end(JSON.stringify({ token: session.token, expiresAt: session.expiresAt, capabilities: [...session.principal.capabilities] }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : "Pairing failed." }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
  const pending = authority.createPairingCode();
  config.onPairingCode(pending.code, pending.expiresAt);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      authority.revokeAll();
      server.close((error) => error ? reject(error) : resolve());
    }),
    revokeAll: () => authority.revokeAll(),
  };
}
