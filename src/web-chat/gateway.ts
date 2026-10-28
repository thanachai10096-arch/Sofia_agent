import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type ApiKeyMap = Record<string, string[]>;
interface WebSession { apiKey: string; expiresAt: number; }
const SESSION_COOKIE = "sofia_web_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 8;

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Sofia Agent · Chat</title>
<style>
:root{color-scheme:dark;--bg:#0b110e;--panel:#121b16;--line:#293a30;--text:#e9f5ed;--muted:#9bb1a2;--accent:#71e39a;--danger:#ff9b9b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#173323 0,#0b110e 55%);color:var(--text);font:16px/1.5 system-ui,-apple-system,sans-serif;min-height:100vh}
main{width:min(860px,100%);margin:0 auto;padding:24px 16px 48px}.brand{display:flex;align-items:center;gap:12px;margin:12px 0 28px}.mark{width:42px;height:42px;border-radius:14px;background:#183e29;color:var(--accent);display:grid;place-items:center;font-weight:800;font-size:23px}.muted{color:var(--muted)}h1{font-size:22px;margin:0}h2{font-size:16px;margin:0 0 14px}.panel{background:rgba(18,27,22,.94);border:1px solid var(--line);border-radius:18px;padding:20px;margin:14px 0;box-shadow:0 14px 48px #0002}
label{display:block;color:var(--muted);font-size:13px;margin:12px 0 6px}input,textarea,select{width:100%;background:#0b120e;border:1px solid #34493b;border-radius:10px;color:var(--text);padding:12px;font:inherit}textarea{min-height:120px;resize:vertical}button{border:0;border-radius:10px;background:var(--accent);color:#092113;font-weight:700;padding:11px 16px;font:inherit;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.secondary{background:#22372a;color:var(--text);border:1px solid #3c5945}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row>*{flex:1}.row button{flex:0 0 auto}.status{white-space:pre-wrap;overflow-wrap:anywhere;background:#09100c;border:1px solid var(--line);border-radius:12px;padding:14px;min-height:76px}.error{color:var(--danger)}.hidden{display:none!important}.small{font-size:13px}.topline{display:flex;align-items:center;justify-content:space-between;gap:12px}.hint{font-size:12px;color:var(--muted);margin-top:8px}
@media(max-width:520px){main{padding:14px 12px 32px}.panel{padding:15px}.row>*{flex-basis:100%}.row button{width:100%}}
</style>
</head>
<body><main>
<header class="brand"><div class="mark">S</div><div><h1>Sofia Agent</h1><div class="muted small">A natural chat interface for your Sofia API</div></div></header>
<section id="login" class="panel">
<h2>Connect to Sofia</h2><p class="muted small">Use your Sofia API key. It is sent to this server over HTTPS and held server-side for this temporary session; it is not saved in browser storage.</p>
<form id="loginForm"><label for="apiKey">Sofia API key</label><input id="apiKey" type="password" autocomplete="current-password" required maxlength="512" placeholder="Paste your API key"><div class="row" style="margin-top:14px"><button id="loginButton" type="submit">Connect</button></div></form><p id="loginError" class="error small" role="status"></p>
</section>
<section id="chat" class="hidden">
<div class="panel"><div class="topline"><div><h2>Model preference</h2><div class="muted small">Choose a profile or let Sofia decide</div></div><button id="logout" class="secondary" type="button">Disconnect</button></div>
<label for="model">Default model profile</label><div class="row"><select id="model"><option value="auto">Auto — Sofia chooses</option><option value="fast">Fast — quick tasks</option><option value="coding">Coding — code work</option><option value="reasoning">Reasoning — deeper analysis</option><option value="vision">Vision — image-capable tasks</option></select><button id="saveModel" type="button">Save</button></div><p id="modelStatus" class="muted small" role="status"></p></div>
<div class="panel"><h2>Chat</h2><form id="chatForm"><label for="task">What would you like Sofia to do?</label><textarea id="task" required maxlength="20000" placeholder="Ask naturally — no /run command needed."></textarea><label for="runModel">Model for this message</label><select id="runModel"><option value="auto">Use saved preference / automatic routing</option><option value="fast">Fast</option><option value="coding">Coding</option><option value="reasoning">Reasoning</option><option value="vision">Vision</option></select><p class="hint">A specific profile applies only to this message. “Auto” respects the saved default; if no default is saved, Sofia routes automatically.</p><div class="row" style="margin-top:14px"><button id="send" type="submit">Send to Sofia</button></div></form></div>
<div class="panel"><h2>Run status and response</h2><div id="response" class="status" aria-live="polite">Your response will appear here.</div><p id="runMeta" class="muted small"></p></div>
</section>
<footer class="muted small">Keep the server private, use HTTPS, and grant only the API scopes you need.</footer>
</main>
<script>
const $=id=>document.getElementById(id);
const profiles=["auto","fast","coding","reasoning","vision"];
async function api(path,options={}){const r=await fetch(path,{credentials:"same-origin",cache:"no-store",...options,headers:{"content-type":"application/json",...(options.headers||{})}});let data={};try{data=await r.json()}catch{}if(!r.ok)throw new Error(data.message||data.error||"Request failed ("+r.status+")");return data}
function showChat(on){$("login").classList.toggle("hidden",on);$("chat").classList.toggle("hidden",!on)}
async function refreshPreference(){const p=await api("/v1/settings/model",{method:"GET"});$("model").value=p.modelSelection;$("modelStatus").textContent=p.source==="saved"?"Saved preference: "+p.modelSelection:"No saved preference; Sofia routes automatically."}
$("loginForm").addEventListener("submit",async e=>{e.preventDefault();$("loginError").textContent="";$("loginButton").disabled=true;try{await api("/web-chat/session",{method:"POST",body:JSON.stringify({apiKey:$("apiKey").value})});$("apiKey").value="";showChat(true);await refreshPreference()}catch(err){$("loginError").textContent="Could not connect. Check the key and its permissions."; }finally{$("loginButton").disabled=false}});
$("logout").addEventListener("click",async()=>{try{await api("/web-chat/session",{method:"DELETE",body:"{}"})}finally{showChat(false);$("response").textContent="Your response will appear here."; $("runMeta").textContent=""}});
$("saveModel").addEventListener("click",async()=>{const b=$("saveModel");b.disabled=true;$("modelStatus").textContent="Saving…";try{const p=await api("/v1/settings/model",{method:"PUT",body:JSON.stringify({modelSelection:$("model").value})});$("modelStatus").textContent="Saved: "+p.modelSelection} catch(e){$("modelStatus").textContent=e.message}finally{b.disabled=false}});
async function pollRun(id){for(let n=0;n<240;n++){const r=await api("/v1/agent/runs/"+encodeURIComponent(id),{method:"GET",headers:{}});$("runMeta").textContent="Run "+id+" · "+r.status;if(r.status==="completed"){const result=r.result||{};$("response").textContent=result.summary||result.output||JSON.stringify(result,null,2);return}if(r.status==="failed"||r.status==="cancelled"){$("response").textContent=r.error||"Run "+r.status;return}await new Promise(resolve=>setTimeout(resolve,1250))}throw new Error("This run is still in progress. Reconnect later using run ID "+id)}
$("chatForm").addEventListener("submit",async e=>{e.preventDefault();const task=$("task").value.trim();if(!task)return;const b=$("send");b.disabled=true;$("response").textContent="Sofia is working…";$("runMeta").textContent="Submitting task";try{const selection=$("runModel").value;const body={task,async:true,sessionId:"web-chat"};if(selection!=="auto")body.modelSelection=selection;const run=await api("/v1/agent/runs",{method:"POST",body:JSON.stringify(body)});$("runMeta").textContent="Run "+run.id+" · "+run.status;await pollRun(run.id)}catch(err){$("response").textContent=err.message}finally{b.disabled=false}});
(async()=>{try{await api("/web-chat/session",{method:"GET"});showChat(true);await refreshPreference()}catch{showChat(false)}})();
</script></body></html>`;

export function createWebChatGateway(apiKeys: ApiKeyMap) {
  const sessions = new Map<string, WebSession>();
  const attempts = new Map<string, { startedAt: number; count: number }>();
  const secureCookie = process.env.SOFIA_WEB_CHAT_COOKIE_SECURE !== "false";

  function cookie(req: IncomingMessage): string | undefined {
    const header = req.headers.cookie ?? "";
    for (const item of header.split(";")) {
      const [name, ...parts] = item.trim().split("=");
      if (name === SESSION_COOKIE) return parts.join("=");
    }
    return undefined;
  }

  function getSession(req: IncomingMessage): WebSession | undefined {
    const token = cookie(req);
    if (!token) return undefined;
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return undefined;
    }
    return session;
  }

  function sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return req.headers["sec-fetch-site"] !== "cross-site";
    try {
      const parsed = new URL(origin);
      return parsed.host === req.headers.host && (parsed.protocol === "https:" || parsed.protocol === "http:");
    } catch { return false; }
  }

  function send(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });
    res.end(JSON.stringify(value));
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk as Buffer);
      size += buffer.length;
      if (size > 4096) return undefined;
      chunks.push(buffer);
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }

  function setCookie(res: ServerResponse, token: string, maxAge: number): void {
    res.setHeader("set-cookie", SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge + (secureCookie ? "; Secure" : ""));
  }

  return {
    apiKeyFor(req: IncomingMessage): string | undefined {
      return getSession(req)?.apiKey;
    },
    sameOrigin,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? "/", "http://sofia.local");
      if (url.pathname === "/web-chat" || url.pathname === "/web-chat/") {
        if (req.method !== "GET") { send(res, 405, { error: "method_not_allowed" }); return true; }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        res.end(PAGE);
        return true;
      }
      if (url.pathname !== "/web-chat/session") return false;
      if (req.method === "GET") {
        const session = getSession(req);
        if (!session) { send(res, 401, { error: "not_authenticated" }); return true; }
        send(res, 200, { authenticated: true, expiresAt: session.expiresAt });
        return true;
      }
      if (!sameOrigin(req)) { send(res, 403, { error: "origin_not_allowed" }); return true; }
      if (req.method === "DELETE") {
        const token = cookie(req);
        if (token) sessions.delete(token);
        setCookie(res, "", 0);
        send(res, 200, { authenticated: false });
        return true;
      }
      if (req.method !== "POST") { send(res, 405, { error: "method_not_allowed" }); return true; }
      const ip = req.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      for (const [address, attempt] of attempts) {
        if (now - attempt.startedAt >= LOGIN_WINDOW_MS) attempts.delete(address);
      }
      for (const [token, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(token);
      }
      const current = attempts.get(ip);
      const state = !current || now - current.startedAt >= LOGIN_WINDOW_MS ? { startedAt: now, count: 0 } : current;
      state.count += 1;
      attempts.set(ip, state);
      if (state.count > LOGIN_MAX_ATTEMPTS) { send(res, 429, { error: "login_rate_limited" }); return true; }
      const input = await readJson(req);
      const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
      const scopes = Object.prototype.hasOwnProperty.call(apiKeys, apiKey) ? apiKeys[apiKey] : undefined;
      if (!apiKey || !scopes || !scopes.some((scope) => scope === "agent:run" || scope === "agent:read")) {
        send(res, 401, { error: "invalid_credentials" });
        return true;
      }
      if (sessions.size >= 10_000) {
        send(res, 503, { error: "web_chat_session_capacity_reached" });
        return true;
      }
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, { apiKey, expiresAt: now + SESSION_TTL_MS });
      setCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
      send(res, 200, { authenticated: true, expiresAt: now + SESSION_TTL_MS });
      return true;
    },
  };
}
