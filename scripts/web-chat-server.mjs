#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(root, "web");
const port = Number(process.env.SOFIA_WEB_CHAT_PORT ?? "4173");
const host = process.env.SOFIA_WEB_CHAT_HOST ?? "127.0.0.1";
const apiKey = process.env.SOFIA_API_KEY?.trim() ?? "";
const apiBase = process.env.SOFIA_API_URL?.trim() ?? "http://127.0.0.1:3000";
const maxBodyBytes = 64 * 1024;
const staticFiles = new Map([
  ["/", ["chat.html", "text/html; charset=utf-8"]],
  ["/chat.html", ["chat.html", "text/html; charset=utf-8"]],
  ["/chat.css", ["chat.css", "text/css; charset=utf-8"]],
  ["/chat.js", ["chat.js", "text/javascript; charset=utf-8"]],
]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("SOFIA_WEB_CHAT_PORT must be a valid TCP port.");
if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("The built-in Web Chat server only binds to loopback. Use a separately authenticated BFF for remote hosting.");
if (!apiKey) throw new Error("SOFIA_API_KEY is required and must remain server-side.");
const base = new URL(apiBase);
const loopbackHttp = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
if (base.protocol !== "https:" && !loopbackHttp) throw new Error("SOFIA_API_URL must use HTTPS (HTTP is allowed only for loopback development).");
if (base.username || base.password || base.search || base.hash) throw new Error("SOFIA_API_URL must not contain credentials, query strings, or fragments.");
const apiOrigin = base.toString().replace(/\/$/, "");

function send(res, status, body, contentType = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  res.end(contentType.startsWith("application/json") ? JSON.stringify(body) : body);
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    const data = Buffer.from(chunk); size += data.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("request_too_large"), { status: 413 });
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("invalid_json"), { status: 400 }); }
}
function allowedHost(req) {
  const value = req.headers.host ?? "";
  return value === "localhost:" + port || value === "127.0.0.1:" + port ||
    (host === "::1" && value === "[::1]:" + port);
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin non-browser clients may omit Origin
  const hostHeader = req.headers.host;
  return origin === "http://" + hostHeader;
}
async function upstream(pathname, method, payload) {
  const response = await fetch(apiOrigin + pathname, {
    method,
    headers: { authorization: "Bearer " + apiKey, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(35_000),
    redirect: "error",
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: "upstream_invalid_response" }; }
  return { status: response.status, data };
}
const server = createServer(async (req, res) => {
  if (!allowedHost(req)) return send(res, 403, { error: "invalid_host" });
  if (!sameOrigin(req)) return send(res, 403, { error: "cross_origin_request_rejected" });
  const requestUrl = new URL(req.url ?? "/", "http://localhost:" + port);
  if (req.method === "GET" && staticFiles.has(requestUrl.pathname)) {
    const [name, type] = staticFiles.get(requestUrl.pathname);
    try { return send(res, 200, await readFile(path.join(webRoot, name)), type); }
    catch { return send(res, 500, { error: "web_asset_unavailable" }); }
  }
  if (requestUrl.pathname === "/bridge/health" && req.method === "GET") {
    try {
      const result = await upstream("/health", "GET");
      return send(res, result.status, { ok: result.status >= 200 && result.status < 300 });
    } catch { return send(res, 502, { error: "sofia_api_unreachable" }); }
  }
  if (requestUrl.pathname === "/bridge/model" && ["GET", "PUT", "DELETE"].includes(req.method ?? "")) {
    try {
      const payload = req.method === "PUT" ? await readJson(req) : undefined;
      if (payload !== undefined && (typeof payload.modelSelection !== "string" ||
        !["auto", "fast", "coding", "reasoning", "vision"].includes(payload.modelSelection))) {
        return send(res, 400, { error: "invalid_model_selection" });
      }
      const result = await upstream("/v1/settings/model", req.method, payload);
      return send(res, result.status, result.data);
    } catch (error) { return send(res, error.status ?? 502, { error: error.message ?? "upstream_request_failed" }); }
  }
  if (requestUrl.pathname === "/bridge/runs" && req.method === "POST") {
    try {
      const payload = await readJson(req);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        typeof payload.task !== "string" || !payload.task.trim() || payload.task.length > 12_000 ||
        typeof payload.sessionId !== "string" || payload.sessionId.length > 128 ||
        (payload.modelSelection !== undefined && !["auto", "fast", "coding", "reasoning", "vision"].includes(payload.modelSelection))) {
        return send(res, 400, { error: "invalid_run_request" });
      }
      const result = await upstream("/v1/agent/runs", "POST", { ...payload, async: true });
      return send(res, result.status, result.data);
    } catch (error) { return send(res, error.status ?? 502, { error: error.message ?? "upstream_request_failed" }); }
  }
  const runMatch = requestUrl.pathname.match(/^\/bridge\/runs\/([0-9a-f-]{36})$/i);
  if (runMatch && req.method === "GET") {
    try { const result = await upstream("/v1/agent/runs/" + runMatch[1], "GET"); return send(res, result.status, result.data); }
    catch { return send(res, 502, { error: "upstream_request_failed" }); }
  }
  if (requestUrl.pathname === "/bridge/memory" && ["GET", "POST"].includes(req.method ?? "")) {
    try {
      if (req.method === "GET") {
        const query = requestUrl.searchParams.get("q");
        const result = await upstream("/v1/memory" + (query ? "?q=" + encodeURIComponent(query) : ""), "GET");
        return send(res, result.status, result.data);
      }
      const payload = await readJson(req);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        !["preference", "fact", "goal", "instruction"].includes(payload.kind) ||
        typeof payload.content !== "string" || !payload.content.trim() || payload.content.length > 1200) {
        return send(res, 400, { error: "invalid_memory_entry" });
      }
      const result = await upstream("/v1/memory", "POST", payload);
      return send(res, result.status, result.data);
    } catch (error) { return send(res, error.status ?? 502, { error: error.message ?? "upstream_request_failed" }); }
  }
  const memoryMatch = requestUrl.pathname.match(/^\/bridge\/memory\/([A-Za-z0-9_-]{1,256})$/);
  if (memoryMatch && req.method === "DELETE") {
    try { const result = await upstream("/v1/memory/" + encodeURIComponent(memoryMatch[1]), "DELETE"); return send(res, result.status, result.data); }
    catch { return send(res, 502, { error: "upstream_request_failed" }); }
  }
  return send(res, 404, { error: "not_found" });
});
server.listen(port, host, () => {
  console.log("Sofia Web Chat listening on http://" + (host === "::1" ? "[::1]" : host) + ":" + port);
  console.log("The API key is held by this local server and is never sent to browser JavaScript.");
  console.log("For remote/multi-user hosting, deploy behind a real authenticated session BFF; this server is loopback-only.");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
