import { McpStdioTransport, type McpStdioTransportOptions } from "./transports.js";
import type { McpTransport } from "./client.js";
import type { ManagedMcpServerConfig } from "./registry.js";

type StdioServerInput = {
  id: string;
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  inheritEnv?: string[];
  env?: Record<string, string>;
  allowedTools: string[];
};

class LazyStdioTransport implements McpTransport {\n  private instance?: McpStdioTransport;\n  constructor(private readonly options: McpStdioTransportOptions) {}\n  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {\n    this.instance ??= new McpStdioTransport(this.options);\n    return this.instance.request(method, params, signal);\n  }\n  notify(method: string, params?: unknown): Promise<void> {\n    this.instance ??= new McpStdioTransport(this.options);\n    return this.instance.notify(method, params);\n  }\n  async close(): Promise<void> { await this.instance?.close(); }\n}\n\nfunction isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse operator-owned MCP server configuration. No servers are discovered or
 * installed automatically; every remote tool requires an explicit allowlist.
 * This first runtime bootstrap intentionally supports stdio only. HTTP MCP
 * requires deployment-level egress/SSRF controls before it can be enabled.
 */
export function loadManagedMcpServersFromEnv(
  raw = process.env.SOFIA_MCP_SERVERS_JSON,
): ManagedMcpServerConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("SOFIA_MCP_SERVERS_JSON must contain valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length > 16) {
    throw new Error("SOFIA_MCP_SERVERS_JSON must be an array of at most 16 stdio servers.");
  }

  const ids = new Set<string>();
  return parsed.map((item, index) => {
    if (!isRecord(item)) throw new Error("MCP server entry " + index + " must be an object.");
    const allowedKeys = new Set(["id", "transport", "command", "args", "cwd", "inheritEnv", "env", "allowedTools"]);
    if (Object.keys(item).some((key) => !allowedKeys.has(key))) {
      throw new Error("MCP server entry " + index + " contains an unsupported property.");
    }
    if (item.transport !== "stdio" || typeof item.id !== "string" ||
        typeof item.command !== "string" || !item.command.trim() ||
        !Array.isArray(item.allowedTools) || item.allowedTools.length === 0 ||
        item.allowedTools.some((value) => typeof value !== "string")) {
      throw new Error("MCP server entry " + index + " requires id, transport=stdio, command, and an explicit allowedTools array.");
    }
    if (ids.has(item.id)) throw new Error("Duplicate MCP server id: " + item.id);
    ids.add(item.id);
    const stringArray = (value: unknown, label: string): string[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error("MCP " + label + " must be an array of strings.");
      }
      return value as string[];
    };
    let env: Record<string, string> | undefined;
    if (item.env !== undefined) {
      if (!isRecord(item.env) || Object.values(item.env).some((value) => typeof value !== "string")) {
        throw new Error("MCP env must be an object containing only string values.");
      }
      env = item.env as Record<string, string>;
    }
    const options: McpStdioTransportOptions = {
      command: item.command,
      ...(stringArray(item.args, "args") ? { args: stringArray(item.args, "args") } : {}),
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
      ...(stringArray(item.inheritEnv, "inheritEnv") ? { inheritEnv: stringArray(item.inheritEnv, "inheritEnv") } : {}),
      ...(env ? { env } : {}),
    };
    return {
      transport: new LazyStdioTransport(options),
      options: { id: item.id, allowedTools: item.allowedTools as string[] },
    };
  });
}
