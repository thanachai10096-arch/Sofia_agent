import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { DesktopAction } from "./types.js";
import { describeDesktopAction } from "./local-host.js";

export interface LocalGuiApprovalOptions {
  openUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export interface LocalGuiApproval {
  requestApproval(action: DesktopAction, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * A per-action, loopback-only approval page. The bearer nonce is placed in the
 * URL fragment (never sent in HTTP requests or Referer headers), is bound to
 * the exact action summary, expires quickly, and can be consumed only once.
 */
export function createLocalGuiApproval(options: LocalGuiApprovalOptions = {}): LocalGuiApproval {
  const timeoutMs = Math.min(120_000, Math.max(10_000, options.timeoutMs ?? 60_000));
  const openUrl = options.openUrl ?? openSystemBrowser;
  let closed = false;
  let activeServer: ReturnType<typeof createServer> | undefined;
  let activeReject: ((error: Error) => void) | undefined;

  const closeServer = async () => {
    const server = activeServer;
    activeServer = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    async requestApproval(action, signal) {
      if (closed) throw new Error("Local approval UI is closed.");
      if (signal?.aborted) return false;
      if (activeServer) throw new Error("A local desktop approval is already pending.");
      const nonce = randomBytes(32).toString("base64url");
      const nonceDigest = createHash("sha256").update(nonce).digest();
      const actionText = describeDesktopAction(action);
      let consumed = false;
      let resolveDecision!: (approved: boolean) => void;
      const decision = new Promise<boolean>((resolve) => { resolveDecision = resolve; });
      const finish = (approved: boolean) => {
        if (consumed) return;
        consumed = true;
        resolveDecision(approved);
      };

      const html = approvalHtml(actionText);
      const server = createServer((req, res) => {
        void handleRequest(req, res);
      });
      activeServer = server;
      activeReject = (error) => { finish(false); void closeServer(); void error; };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const onAbort = () => finish(false);
      signal?.addEventListener("abort", onAbort, { once: true });

      const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
        const address = server.address() as AddressInfo | null;
        const origin = address ? `http://127.0.0.1:${address.port}` : "";
        const headers = {
          "cache-control": "no-store, max-age=0",
          "content-security-policy": "default-src 'none'; script-src 'nonce-sofiaapproval'; style-src 'nonce-sofiaapproval'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "cross-origin-resource-policy": "same-origin",
        };
        if (req.method === "GET" && req.url === "/") {
          res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        if (req.method !== "POST" || req.url !== "/decision") {
          res.writeHead(404, headers); res.end("Not found"); return;
        }
        if (req.headers.host !== `127.0.0.1:${address?.port}` ||
            req.headers.origin !== origin ||
            req.headers["content-type"] !== "application/json") {
          res.writeHead(403, headers); res.end("Forbidden"); return;
        }
        const supplied = req.headers["x-sofia-approval-token"];
        if (typeof supplied !== "string" || supplied.length > 128) {
          res.writeHead(403, headers); res.end("Forbidden"); return;
        }
        const suppliedDigest = createHash("sha256").update(supplied).digest();
        if (suppliedDigest.length !== nonceDigest.length || !timingSafeEqual(suppliedDigest, nonceDigest) || consumed) {
          res.writeHead(403, headers); res.end("Forbidden"); return;
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString("utf8");
          if (Buffer.byteLength(body, "utf8") > 256) {
            res.writeHead(413, headers); res.end("Too large"); return;
          }
        }
        let payload: unknown;
        try { payload = JSON.parse(body); } catch { res.writeHead(400, headers); res.end("Invalid JSON"); return; }
        if (!payload || typeof payload !== "object" ||
            !["approve", "deny"].includes((payload as { decision?: string }).decision ?? "")) {
          res.writeHead(400, headers); res.end("Invalid decision"); return;
        }
        finish((payload as { decision: string }).decision === "approve");
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        setImmediate(() => { void closeServer(); });
      };

      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
        });
        const address = server.address() as AddressInfo;
        const url = `http://127.0.0.1:${address.port}/#${nonce}`;
        await openUrl(url);
        return await decision;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        activeReject = undefined;
        await closeServer();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      activeReject?.(new Error("Local approval UI closed."));
      await closeServer();
    },
  };
}

function approvalHtml(actionText: string): string {
  const escaped = actionText.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sofia — Local approval</title><style nonce="sofiaapproval">*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b1020;color:#edf2ff;font:16px system-ui;display:grid;place-items:center;padding:24px}.panel{width:min(560px,100%);background:#151d32;border:1px solid #33415f;border-radius:22px;padding:28px;box-shadow:0 24px 80px #0008}h1{font-size:24px;margin:0 0 8px}.muted{color:#aab7d2;line-height:1.5}.action{white-space:pre-wrap;overflow-wrap:anywhere;background:#0b1224;border:1px solid #34415d;border-radius:14px;padding:16px;margin:22px 0}.buttons{display:flex;gap:12px}.buttons button{flex:1;border:0;border-radius:12px;padding:14px;font-weight:700;font-size:15px;cursor:pointer}.allow{background:#d9f99d;color:#17220a}.deny{background:#33415f;color:white}button:focus-visible{outline:3px solid #93c5fd;outline-offset:3px}#status{min-height:24px;margin-top:16px;color:#cbd5e1}</style><main class="panel"><h1>Approve local desktop action?</h1><p class="muted">Sofia is requesting an action on this computer. Review the exact action before deciding. This approval is valid once and expires automatically.</p><pre class="action">${escaped}</pre><div class="buttons"><button class="deny" id="deny">Deny</button><button class="allow" id="approve">Approve</button></div><p id="status" role="status"></p></main><script nonce="sofiaapproval">(()=>{const token=location.hash.slice(1);history.replaceState(null,"",location.pathname);let used=false;async function decide(decision){if(used||!token)return;used=true;document.querySelectorAll("button").forEach(b=>b.disabled=true);try{const r=await fetch("/decision",{method:"POST",headers:{"content-type":"application/json","x-sofia-approval-token":token},body:JSON.stringify({decision})});document.getElementById("status").textContent=r.ok?(decision==="approve"?"Approved. You may close this page.":"Denied. You may close this page."):"This approval expired or is no longer valid."; }catch{document.getElementById("status").textContent="Could not contact the local companion.";}}document.getElementById("approve").addEventListener("click",()=>decide("approve"));document.getElementById("deny").addEventListener("click",()=>decide("deny"));if(!token){document.getElementById("status").textContent="Missing approval token. Close this page.";}})();</script></html>`;
}

async function openSystemBrowser(url: string): Promise<void> {
  const candidates = process.platform === "darwin"
    ? [{ command: "open", args: [url] }]
    : process.platform === "win32"
      ? [{ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }]
      : [{ command: "xdg-open", args: [url] }];
  const candidate = candidates[0]!;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(candidate.command, candidate.args, {
      shell: false, detached: true, stdio: "ignore", windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
