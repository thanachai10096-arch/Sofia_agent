import type { ExecutionPolicy } from "../security/policy.js";
import { connectManagedMcpRegistry, type ManagedMcpServerConfig } from "./registry.js";
import { McpHttpTransport, McpStdioTransport } from "./transports.js";

type StdioServerConfig = {
  id: string;
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  inheritEnv?: string[];
  env?: Record<string, string>;
  allowedTools: string[];
};

type HttpServerConfig = {
  id: string;
  transport: "http";
  endpoint: string;
  headers?: Record<string, string>;
  allowedTools: string[];
};

type ServerConfig = StdioServerConfig | HttpServerConfig;

const MAX_CONFIG_BYTES = 32_768;
const MAX_SERVERS = 12;
const MAX_TOOLS_PER_SERVER = 64;
const SAFE_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const SAFE_TOOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid SOFIA_MCP_SERVERS: expected " + label + " object");
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid SOFIA_MCP_SERVERS: " + label + " must be a non-empty string");
  return value;
}

function stringArray(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max ||
      value.some((item) => typeof item !== "string" || !item.trim() || item.length > 256)) {
    throw new Error("Invalid SOFIA_MCP_SERVERS: " + label + " must be a non-empty bounded string array");
  }
  return value as string[];
}

function parseServer(value: unknown): ServerConfig {
  const item = asObject(value, "server");
  const id = stringField(item.id, "server id", 48);
  if (!SAFE_ID.test(id)) throw new Error("Invalid SOFIA_MCP_SERVERS: server id must be a lowercase slug");
  const allowedTools = stringArray(item.allowedTools, id + ".allowedTools", MAX_TOOLS_PER_SERVER);
  const readOnlyTools = item.readOnlyTools === undefined ? undefined : stringArray(item.readOnlyTools, id + ".readOnlyTools", MAX_TOOLS_PER_SERVER);\n  if (allowedTools.some((name) => !SAFE_TOOL.test(name)) || new Set(allowedTools).size !== allowedTools.length) {
    throw new Error("Invalid SOFIA_MCP_SERVERS: invalid or duplicate tool name in " + id);
  }

  if (item.transport === "stdio") {
    const command = stringField(item.command, id + ".command", 512);
    const args = item.args === undefined ? undefined : (Array.isArray(item.args) && item.args.length === 0 ? [] : stringArray(item.args, id + ".args", 64));
    const cwd = item.cwd === undefined ? undefined : stringField(item.cwd, id + ".cwd", 2048);
    const inheritEnv = item.inheritEnv === undefined ? undefined : (Array.isArray(item.inheritEnv) && item.inheritEnv.length === 0 ? [] : stringArray(item.inheritEnv, id + ".inheritEnv", 64));
    const env = item.env === undefined ? undefined : asObject(item.env, id + ".env");
    if (env && Object.entries(env).some(([key, val]) => !SAFE_ENV_KEY.test(key) || typeof val !== "string" || val.length > 4096)) {
      throw new Error("Invalid SOFIA_MCP_SERVERS: invalid environment entry in " + id);
    }
    const allowed = new Set(["id", "transport", "command", "args", "cwd", "inheritEnv", "env", "allowedTools", "readOnlyTools"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error("Invalid SOFIA_MCP_SERVERS: unknown field in " + id);
    return { id, transport: "stdio", command, allowedTools, ...(args ? { args } : {}), ...(cwd ? { cwd } : {}), ...(inheritEnv ? { inheritEnv } : {}), ...(env ? { env: env as Record<string, string> } : {}), ...(readOnlyTools ? { readOnlyTools } : {}) };
  }

  if (item.transport === "http") {
    const endpoint = stringField(item.endpoint, id + ".endpoint", 2048);
    const headers = item.headers === undefined ? undefined : asObject(item.headers, id + ".headers");
    if (headers && Object.entries(headers).some(([key, val]) =>
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(key) ||
      ["host", "content-length", "connection", "mcp-session-id"].includes(key.toLowerCase()) ||
      typeof val !== "string" || val.length > 4096 || /[\r\n]/.test(val))) {
      throw new Error("Invalid SOFIA_MCP_SERVERS: invalid HTTP header in " + id);
    }
    const allowed = new Set(["id", "transport", "endpoint", "headers", "allowedTools", "readOnlyTools"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error("Invalid SOFIA_MCP_SERVERS: unknown field in " + id);
    return { id, transport: "http", endpoint, allowedTools, ...(headers ? { headers: headers as Record<string, string> } : {}), ...(readOnlyTools ? { readOnlyTools } : {}) };
  }

  throw new Error("Invalid SOFIA_MCP_SERVERS: transport must be stdio or http for " + id);
}

/** Parse only operator-supplied, bounded MCP configuration. */
export function parseMcpServersConfig(raw: string): ServerConfig[] {
  if (raw.length > MAX_CONFIG_BYTES) throw new Error("SOFIA_MCP_SERVERS exceeds the 32 KiB configuration limit");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("SOFIA_MCP_SERVERS must contain valid JSON"); }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SERVERS) {
    throw new Error("SOFIA_MCP_SERVERS must be an array containing 1 to 12 servers");
  }
  const servers = value.map(parseServer);
  if (new Set(servers.map((server) => server.id)).size !== servers.length) throw new Error("SOFIA_MCP_SERVERS contains duplicate server ids");
  return servers;
}

/**
 * Connect explicitly configured MCP servers. MCP is opt-in, and every tool is
 * filtered by an operator allowlist before it reaches Sofia's normal ToolGateway.
 */
export async function connectMcpFromEnv(policy: ExecutionPolicy) {
  const raw = process.env.SOFIA_MCP_SERVERS?.trim();
  if (!raw) return undefined;
  if (!policy.allowTools || !policy.allowNetwork) {
    throw new Error("SOFIA_ALLOW_TOOLS=true and SOFIA_ALLOW_NETWORK=true are required when SOFIA_MCP_SERVERS is configured");
  }

  const servers = parseMcpServersConfig(raw);
  const configs: ManagedMcpServerConfig[] = servers.map((server) => {
    if (server.transport === "stdio") {
      return {
        transport: new McpStdioTransport(server),
        options: { id: server.id, allowedTools: server.allowedTools, ...(server.readOnlyTools ? { readOnlyTools: server.readOnlyTools } : {}) },
      };
    }

    let endpoint: URL;
    try { endpoint = new URL(server.endpoint); }
    catch { throw new Error("Invalid MCP HTTP endpoint for server " + server.id); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("MCP HTTP endpoint must be HTTPS and must not contain credentials, query parameters, or fragments: " + server.id);
    }
    const hostAllowed = policy.allowedHosts.some((host) =>
      host.startsWith("*.") ? endpoint.hostname === host.slice(2) || endpoint.hostname.endsWith("." + host.slice(2))
        : endpoint.hostname === host,
    );
    if (!hostAllowed) throw new Error("MCP HTTP endpoint host is not in SOFIA_ALLOWED_HOSTS: " + server.id);
    return {
      transport: new McpHttpTransport({ endpoint: endpoint.toString(), ...(server.headers ? { headers: server.headers } : {}) }),
      options: { id: server.id, allowedTools: server.allowedTools },
    };
  });

  return connectManagedMcpRegistry([], configs);
}
