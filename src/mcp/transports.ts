import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { McpTransport } from "./client.js";

type JsonRpcMessage = { jsonrpc?: string; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
function parseMessage(line: string): JsonRpcMessage | undefined {
  if (!line.trim()) return undefined;
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("MCP server emitted invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP server emitted an invalid JSON-RPC message");
  return value as JsonRpcMessage;
}
function responseValue(message: JsonRpcMessage): unknown {
  if (message.error) {
    const code = typeof message.error.code === "number" ? message.error.code : "unknown";
    const text = typeof message.error.message === "string" ? message.error.message : "MCP request failed";
    throw new Error("MCP JSON-RPC error " + code + ": " + text);
  }
  if (!("result" in message)) throw new Error("MCP response did not contain a result");
  return message.result;
}
export interface McpStdioTransportOptions { command: string; args?: string[]; cwd?: string; inheritEnv?: string[]; env?: Record<string, string>; }

export class McpStdioTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader: ReadlineInterface;
  private readonly pending = new Map<string | number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  private nextId = 1;
  private closed = false;
  constructor(options: McpStdioTransportOptions) {
    if (!options.command.trim()) throw new Error("MCP stdio command must not be empty");
    const safeEnv: Record<string, string> = {};
    const inherited = options.inheritEnv ?? ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"];
    for (const key of inherited) if (process.env[key] !== undefined) safeEnv[key] = process.env[key]!;
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid MCP environment variable name: " + key);
      safeEnv[key] = value;
    }
    this.child = spawn(options.command, options.args ?? [], { cwd: options.cwd, env: safeEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.reader = createInterface({ input: this.child.stdout });
    // Drain stderr without echoing potentially sensitive server output into Sofia logs.
    this.child.stderr.on("data", () => undefined);
    this.reader.on("line", (line) => {
      try {
        const message = parseMessage(line);
        if (!message || message.id === undefined) return;
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        waiter.cleanup();
        try { waiter.resolve(responseValue(message)); }
        catch (error) { waiter.reject(error instanceof Error ? error : new Error("MCP request failed")); }
      } catch (error) { this.failAll(error instanceof Error ? error : new Error("MCP stdio protocol error")); }
    });
    this.child.on("error", (error) => { this.closed = true; this.failAll(new Error("MCP server process error: " + error.message)); });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new Error("MCP server exited (code=" + (code ?? "null") + ", signal=" + (signal ?? "none") + ")"));
    });
  }
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    this.assertOpen();
    signal?.throwIfAborted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("MCP request aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
      } catch (error) {
        this.pending.delete(id); signal?.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Failed to write MCP request"));
      }
    });
  }
  async notify(method: string, params?: unknown): Promise<void> {
    this.assertOpen();
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) + "\n");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.reader.close(); this.child.kill(); this.failAll(new Error("MCP transport closed"));
  }
  private assertOpen(): void { if (this.closed) throw new Error("MCP stdio transport is closed"); }
  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) { waiter.cleanup(); waiter.reject(error); }
    this.pending.clear();
  }
}

export interface McpHttpTransportOptions { endpoint: string; headers?: Record<string, string>; fetchImpl?: typeof fetch; }
export class McpHttpTransport implements McpTransport {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | undefined;
  private closed = false;
  constructor(private readonly options: McpHttpTransportOptions) {
    this.endpoint = new URL(options.endpoint);
    if (this.endpoint.protocol !== "https:" && this.endpoint.protocol !== "http:") throw new Error("MCP HTTP endpoint must use http or https");
    if (this.endpoint.username || this.endpoint.password) throw new Error("MCP endpoint must not embed credentials in its URL");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    this.assertOpen(); signal?.throwIfAborted();
    const id = "sofia-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const message = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    const response = await this.fetchImpl(this.endpoint, { method: "POST", headers: this.headers(), body: JSON.stringify(message), signal, redirect: "error" });
    this.captureSession(response);
    if (!response.ok) throw new Error("MCP HTTP request failed with status " + response.status);
    const body = await response.text();
    if (!body.trim()) throw new Error("MCP HTTP response was empty");
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const parsed = parseMessage(data);
        if (parsed?.id === id) return responseValue(parsed);
      }
      throw new Error("MCP SSE response did not contain the matching request id");
    }
    const parsed = parseMessage(body);
    if (!parsed || parsed.id !== id) throw new Error("MCP HTTP response id did not match the request");
    return responseValue(parsed);
  }
  async notify(method: string, params?: unknown): Promise<void> {
    this.assertOpen();
    const response = await this.fetchImpl(this.endpoint, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }), redirect: "error" });
    this.captureSession(response);
    if (!response.ok && response.status !== 202) throw new Error("MCP HTTP notification failed with status " + response.status);
    if (response.status !== 202) await response.body?.cancel();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.sessionId) return;
    try { await this.fetchImpl(this.endpoint, { method: "DELETE", headers: this.headers(), redirect: "error" }); }
    catch { /* Remote session shutdown is best-effort. */ }
    finally { this.sessionId = undefined; }
  }
  private headers(): Record<string, string> {
    return { accept: "application/json, text/event-stream", "content-type": "application/json", ...this.options.headers, ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}) };
  }
  private captureSession(response: Response): void { const value = response.headers.get("mcp-session-id"); if (value) this.sessionId = value; }
  private assertOpen(): void { if (this.closed) throw new Error("MCP HTTP transport is closed"); }
}
