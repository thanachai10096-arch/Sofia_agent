import type { ManagedMcpServerConfig } from "./registry.js";
import { McpHttpTransport, McpStdioTransport } from "./transports.js";

type JsonRecord = Record<string, unknown>;
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
  const validated: ParsedServer[] = parsed.map((entry, index) => {
    const item = record(entry, "MCP server entry " + index);
    if (typeof item.id !== "string") throw new Error("MCP server entry " + index + " requires an id");
    const allowedTools = strings(item.allowedTools, "MCP allowedTools");
    if (!allowedTools?.length) throw new Error("MCP server " + item.id + " requires a non-empty allowedTools list");
    const transport = record(item.transport, "MCP transport");
    if (transport.type === "stdio") {
      if (typeof transport.command !== "string" || !transport.command.trim()) throw new Error("MCP stdio transport requires a command");
      if (transport.cwd !== undefined && typeof transport.cwd !== "string") throw new Error("MCP stdio cwd must be a string");
      return {
        id: item.id,
        allowedTools,
        transport: {
          type: "stdio",
          command: transport.command,
          ...(strings(transport.args, "MCP stdio args", true) ? { args: strings(transport.args, "MCP stdio args", true)! } : {}),
          ...(typeof transport.cwd === "string" ? { cwd: transport.cwd } : {}),
          ...(strings(transport.inheritEnv, "MCP stdio inheritEnv", true) ? { inheritEnv: strings(transport.inheritEnv, "MCP stdio inheritEnv", true)! } : {}),
          ...(stringMap(transport.env, "MCP stdio env") ? { env: stringMap(transport.env, "MCP stdio env")! } : {}),
        },
      };
    }
    if (transport.type === "http") {
      if (typeof transport.endpoint !== "string" || !transport.endpoint.trim()) throw new Error("MCP HTTP transport requires an endpoint");
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
