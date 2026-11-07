import { McpHttpTransport, McpStdioTransport } from "./transports.js";
import { connectManagedMcpRegistry } from "./registry.js";
import type { ManagedMcpToolRegistry } from "./registry.js";
import type { McpStdioTransportOptions } from "./transports.js";
import type { ExecutionPolicy } from "../security/policy.js";

type HttpServerConfig = { id: string; transport: "http"; endpoint: string; allowedTools: string[]; headersEnv?: Record<string, string> };
type StdioServerConfig = { id: string; transport: "stdio"; command: string; args?: string[]; cwd?: string; allowedTools: string[]; envNames?: string[] };
type ServerConfig = HttpServerConfig | StdioServerConfig;

function parseConfig(raw: string): ServerConfig[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("SOFIA_MCP_SERVERS must be valid JSON"); }
  if (!Array.isArray(value) || value.length > 16) throw new Error("SOFIA_MCP_SERVERS must be an array with at most 16 servers");
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid MCP server config at index " + index);
    const config = item as Record<string, unknown>;
    if (typeof config.id !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(config.id) || ids.has(config.id)) throw new Error("Invalid or duplicate MCP server id at index " + index);
    ids.add(config.id);
    if (!Array.isArray(config.allowedTools) || config.allowedTools.length === 0 || config.allowedTools.length > 64 ||
        config.allowedTools.some((name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(name))) {
      throw new Error("MCP server " + config.id + " requires an explicit valid allowedTools list");
    }
    if (config.transport === "http") {
      if (typeof config.endpoint !== "string") throw new Error("MCP HTTP endpoint is required for " + config.id);
      const endpoint = new URL(config.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("MCP HTTP endpoints must use HTTPS and must not embed credentials");
      const headersEnv = config.headersEnv;
      if (headersEnv !== undefined && (!headersEnv || typeof headersEnv !== "object" || Array.isArray(headersEnv) ||
          Object.entries(headersEnv as Record<string, unknown>).some(([header, envName]) => !/^[A-Za-z0-9-]{1,64}$/.test(header) || typeof envName !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(envName)))) {
        throw new Error("Invalid headersEnv mapping for MCP server " + config.id);
      }
      return config as unknown as HttpServerConfig;
    }
    if (config.transport === "stdio") {
      if (typeof config.command !== "string" || !config.command.trim()) throw new Error("MCP stdio command is required for " + config.id);
      if (config.args !== undefined && (!Array.isArray(config.args) || config.args.length > 64 || config.args.some((arg) => typeof arg !== "string" || arg.length > 2048))) throw new Error("Invalid MCP stdio args for " + config.id);
      if (config.cwd !== undefined && (typeof config.cwd !== "string" || !config.cwd.startsWith("/"))) throw new Error("MCP stdio cwd must be an absolute path");
      if (config.envNames !== undefined && (!Array.isArray(config.envNames) || config.envNames.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)))) throw new Error("Invalid MCP stdio envNames for " + config.id);
      return config as unknown as StdioServerConfig;
    }
    throw new Error("Unsupported MCP transport for " + config.id);
  });
}
function policyHostAllowed(host: string, allowedHosts: string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((allowed) => allowed.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "") === normalized);
}

/** Connect only admin-configured MCP servers. User/model input never controls endpoints or commands. */
export async function connectMcpFromEnv(policy: ExecutionPolicy): Promise<ManagedMcpToolRegistry | undefined> {
  const raw = process.env.SOFIA_MCP_SERVERS?.trim();
  if (!raw) return undefined;
  if (!policy.allowTools) throw new Error("MCP cannot start while tool execution is disabled");
  const configs = parseConfig(raw);
  const stdioAllowed = new Set((process.env.SOFIA_MCP_STDIO_ALLOWED_COMMANDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  // Preflight every transport before spawning any stdio child process.
  for (const config of configs) {
    if (config.transport === "http") {
      const endpoint = new URL(config.endpoint);
      if (!policy.allowNetwork || !policyHostAllowed(endpoint.hostname, policy.allowedHosts)) throw new Error("MCP HTTP server " + config.id + " is blocked: enable network and allowlist its exact hostname");
    } else if (!stdioAllowed.has(config.command)) {
      throw new Error("MCP stdio command is not in SOFIA_MCP_STDIO_ALLOWED_COMMANDS: " + config.command);
    }
  }
  const servers = configs.map((config) => {
    if (config.transport === "http") {
      const endpoint = new URL(config.endpoint);
      if (!policy.allowNetwork || !policyHostAllowed(endpoint.hostname, policy.allowedHosts)) {
        throw new Error("MCP HTTP server " + config.id + " is blocked: enable network and allowlist its exact hostname");
      }
      const headers: Record<string, string> = {};
      for (const [header, envName] of Object.entries(config.headersEnv ?? {})) {
        const value = process.env[envName];
        if (!value) throw new Error("Missing environment variable " + envName + " for MCP server " + config.id);
        headers[header] = value;
      }
      return { transport: new McpHttpTransport({ endpoint: config.endpoint, headers }), options: { id: config.id, allowedTools: config.allowedTools, requiresNetwork: true } };
    }
    if (!stdioAllowed.has(config.command)) throw new Error("MCP stdio command is not in SOFIA_MCP_STDIO_ALLOWED_COMMANDS: " + config.command);
    const env: Record<string, string> = {};
    for (const name of config.envNames ?? []) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const options: McpStdioTransportOptions = { command: config.command, args: config.args, cwd: config.cwd, env };
    return { transport: new McpStdioTransport(options), options: { id: config.id, allowedTools: config.allowedTools, requiresNetwork: false } };
  });
  try { return await connectManagedMcpRegistry([], servers); }
  catch (error) {
    await Promise.allSettled(servers.map(({ transport }) => transport.close()));
    throw error;
  }
}
