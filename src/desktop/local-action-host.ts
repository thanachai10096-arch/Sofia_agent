import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import { validateToolInput } from "../tools/types.js";
import { createDesktopAdapterTools } from "./adapter.js";
import { DesktopPairingAuthority } from "./pairing.js";
import type { DesktopAction, DesktopAdapterConfig, DesktopCapability, DesktopHostDriver, DesktopPrincipal } from "./types.js";

export interface LocalDesktopActionHostConfig {
  /** Capabilities the operator permits this local host to grant during pairing. */
  allowedCapabilities: readonly DesktopCapability[];
  /** Exact web origins permitted to call the loopback service. Never use '*'. */
  allowedOrigins?: readonly string[];
  /** A real, user-facing approval prompt. Mutating/input actions fail closed without it. */
  requestApproval: (action: DesktopAction) => Promise<boolean>;
  driver: DesktopHostDriver;
  runtime: WorkspaceRuntime;
  allowedApplications?: readonly string[];
  maxTextLength?: number;
  maxConcurrentActions?: number;
  onPairingCode: (code: string, expiresAt: number) => void;
}

export interface LocalDesktopActionHost {
  url: string;
  close(): Promise<void>;
  revokeAll(): void;
}

const MAX_BODY_BYTES = 16 * 1024;
const MAX_SCREEN_BYTES = 5 * 1024 * 1024;

async function readJson(req: AsyncIterable<unknown>, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function localOriginAllowed(origin: string, port: number, configured: readonly string[]): boolean {
  if (configured.length > 0) return configured.includes(origin);
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.port === String(port);
  } catch {
    return false;
  }
}

function responseHeaders(origin?: string) {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
    "content-type": "application/json; charset=utf-8",
    ...(origin ? {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      vary: "Origin",
    } : {}),
  };
}

function send(res: import("node:http").ServerResponse, status: number, value: unknown, origin?: string) {
  res.writeHead(status, responseHeaders(origin));
  res.end(JSON.stringify(value));
}

/**
 * Explicitly started loopback bridge for a local web/desktop client.
 * Pairing is required before actions; the bridge never binds to a public interface.
 * File/process actions are not exposed here—only the separately permissioned native
 * desktop adapter actions are accepted.
 */
export async function startLocalDesktopActionHost(config: LocalDesktopActionHostConfig): Promise<LocalDesktopActionHost> {
  const authority = new DesktopPairingAuthority({ allowedCapabilities: config.allowedCapabilities });
  const maxConcurrent = Math.min(Math.max(1, config.maxConcurrentActions ?? 2), 8);
  const activeByPrincipal = new Map<string, number>();
  let port = 0;

  const server = createServer(async (req, res) => {
    const host = req.headers.host?.toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, { "cache-control": "no-store", vary: "Origin" }).end();
      return;
    }

    const origin = req.headers.origin;
    if (origin && !localOriginAllowed(origin, port, config.allowedOrigins ?? [])) {
      res.writeHead(403, { "cache-control": "no-store", vary: "Origin" }).end();
      return;
    }

    if (req.method === "OPTIONS") {
      if (origin) {
        res.writeHead(204, responseHeaders(origin));
      } else {
        res.writeHead(204, { "cache-control": "no-store" });
      }
      res.end();
      return;
    }

    if (req.method !== "POST") {
      send(res, 405, { error: "method_not_allowed" }, origin);
      return;
    }

    if (req.url === "/pair") {
      try {
        const body = await readJson(req, 4096);
        if (!isRecord(body) || typeof body.code !== "string") throw new Error("Pairing code is required.");
        const requested = body.capabilities ?? [];
        if (!Array.isArray(requested) || requested.some((value) => typeof value !== "string")) {
          throw new Error("Capabilities must be an array of strings.");
        }
        const session = authority.pair(body.code, requested as DesktopCapability[]);
        send(res, 200, {
          token: session.token,
          expiresAt: session.expiresAt,
          capabilities: [...session.principal.capabilities],
        }, origin);
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : "Pairing failed." }, origin);
      }
      return;
    }

    if (req.url !== "/action") {
      send(res, 404, { error: "not_found" }, origin);
      return;
    }

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    let principal: DesktopPrincipal;
    try {
      principal = authority.authenticate(token);
    } catch {
      send(res, 401, { error: "unauthorized" }, origin);
      return;
    }

    const active = activeByPrincipal.get(principal.id) ?? 0;
    if (active >= maxConcurrent) {
      send(res, 429, { error: "desktop_action_concurrency_limit" }, origin);
      return;
    }

    try {
      const body = await readJson(req, MAX_BODY_BYTES);
      if (!isRecord(body) || typeof body.tool !== "string" || !isRecord(body.input)) {
        send(res, 400, { error: "invalid_action_request" }, origin);
        return;
      }

      const adapterConfig: DesktopAdapterConfig = {
        driver: config.driver,
        requestApproval: config.requestApproval,
        ...(config.allowedApplications ? { allowedApplications: config.allowedApplications } : {}),
        ...(config.maxTextLength !== undefined ? { maxTextLength: config.maxTextLength } : {}),
      };
      const tool = createDesktopAdapterTools({ config: adapterConfig, principal })
        .find((candidate) => candidate.name === body.tool);
      if (!tool) {
        send(res, 404, { error: "desktop_action_not_supported" }, origin);
        return;
      }

      activeByPrincipal.set(principal.id, active + 1);
      try {
        validateToolInput(tool.inputSchema, body.input);
        const result = await tool.execute(body.input, {
          runtime: config.runtime,
          signal: AbortSignal.timeout(30_000),
        });
        if (tool.name === "desktop.screen.capture" && isRecord(result) && typeof result.dataBase64 === "string") {
          const bytes = Buffer.byteLength(result.dataBase64, "base64");
          if (bytes > MAX_SCREEN_BYTES) {
            send(res, 413, { error: "screen_capture_too_large" }, origin);
            return;
          }
        }
        send(res, 200, { ok: true, result }, origin);
      } finally {
        const current = activeByPrincipal.get(principal.id) ?? 1;
        if (current <= 1) activeByPrincipal.delete(principal.id);
        else activeByPrincipal.set(principal.id, current - 1);
      }
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : "desktop_action_failed" }, origin);
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
