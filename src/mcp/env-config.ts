import type { ManagedMcpServerConfig } from "./registry.js";
import { McpHttpTransport, McpStdioTransport } from "./transports.js";

type JsonRecord = Record<string, unknown>;
const SAFE_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const SAFE_TOOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
type ParsedServer =
  | { id: string; allowedTools: string[]; transport: { type: "stdio"; command: string; args?: string[]; cwd?: string; inheritEnv?: string[]; env?: Record<string, string> } }
  | { id: string; allowedTools: string[]; transport: { type: "http"; endpoint: string; headers?: Record<string, string> } };

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
  return value as JsonRecord;
}
function strings(value: unknown, label: string, optional = false): string[] | undefined {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(label + " must be an array of strings");
  return value as string[];
}
function stringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const object = record(value, label);
  const entries = Object.entries(object);
  if (entries.some(([, item]) => typeof item !== "string")) throw new Error(label + " values must be strings");
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Load only explicit operator-supplied MCP servers. JSON is configuration, never model input. */
export function loadMcpServerConfigsFromEnv(env: NodeJS.ProcessEnv = process.env): ManagedMcpServerConfig[] {
  const raw = env.SOFIA_MCP_SERVERS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("SOFIA_MCP_SERVERS_JSON must contain valid JSON"); }
  if (!Array.isArray(parsed)) throw new Error("SOFIA_MCP_SERVERS_JSON must be a JSON array");

  // Validate the complete configuration before spawning any stdio child process.
  const seenNames = new Set<string>();
  const validated: ParsedServer[] = parsed.map((entry, index) => {
    const item = record(entry, "MCP server entry " + index);
    if (typeof item.id !== "string" || !SAFE_ID.test(item.id)) throw new Error("MCP server entry " + index + " requires a lowercase slug id");
    const allowedTools = strings(item.allowedTools, "MCP allowedTools");
    if (!allowedTools?.length) throw new Error("MCP server " + item.id + " requires a non-empty allowedTools list");
    for (const name of allowedTools) {
      if (!SAFE_TOOL.test(name)) throw new Error("Invalid MCP tool name in allowlist");
      const qualifiedName = "mcp." + item.id + "." + name;
      if (seenNames.has(qualifiedName)) throw new Error("Duplicate MCP tool in configuration: " + qualifiedName);
      seenNames.add(qualifiedName);
    }
    const transport = record(item.transport, "MCP transport");
    if (transport.type === "stdio") {
      if (typeof transport.command !== "string" || !transport.command.trim()) throw new Error("MCP stdio transport requires a command");
      if (transport.cwd !== undefined && typeof transport.cwd !== "string") throw new Error("MCP stdio cwd must be a string");
      const inherited = strings(transport.inheritEnv, "MCP stdio inheritEnv", true);
      const stdioEnv = stringMap(transport.env, "MCP stdio env");
      if (Object.keys(stdioEnv ?? {}).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error("Invalid MCP environment variable name");
      return {
        id: item.id,
        allowedTools,
        transport: {
          type: "stdio",
          command: transport.command,
          ...(strings(transport.args, "MCP stdio args", true) ? { args: strings(transport.args, "MCP stdio args", true)! } : {}),
          ...(typeof transport.cwd === "string" ? { cwd: transport.cwd } : {}),
          ...(inherited ? { inheritEnv: inherited } : {}),
          ...(stdioEnv ? { env: stdioEnv } : {}),
        },
      };
    }
    if (transport.type === "http") {
      if (typeof transport.endpoint !== "string" || !transport.endpoint.trim()) throw new Error("MCP HTTP transport requires an endpoint");
      const endpoint = new URL(transport.endpoint);
      if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:") || endpoint.username || endpoint.password) {
        throw new Error("MCP HTTP endpoint must use HTTP(S) and must not embed credentials");
      }
      const headers = stringMap(transport.headers, "MCP HTTP headers");
      return { id: item.id, allowedTools, transport: { type: "http", endpoint: transport.endpoint, ...(headers ? { headers } : {}) } };
    }
    throw new Error("MCP server " + item.id + " transport type must be stdio or http");
  });

  return validated.map((item) => ({
    transport: item.transport.type === "stdio"
      ? new McpStdioTransport(item.transport)
      : new McpHttpTransport(item.transport),
    options: { id: item.id, allowedTools: item.allowedTools },
  }));
}
