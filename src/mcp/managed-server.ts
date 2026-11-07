import type { SofiaTool } from "../tools/types.js";
import { McpClient, type McpClientOptions, type McpTransport } from "./client.js";

export interface ManagedMcpServerOptions {
  /** Stable, operator-chosen namespace. Never derive this from server metadata. */
  id: string;
  /** Explicit allowlist of tool names advertised by the trusted server. */
  allowedTools: readonly string[];
  client?: McpClientOptions;
  /** Fixed operator-owned destination used by Sofia's network guard; never supplied by model input. */
  trustedNetworkTargets?: readonly string[];
}

export interface ManagedMcpServer {
  tools: SofiaTool[];
  close(): Promise<void>;
}

const SAFE_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const SAFE_TOOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Connects one explicitly configured MCP transport and exposes only operator-allowlisted
 * tools. Server names/descriptions are untrusted metadata and never control local tool names.
 * Returned tools must still be registered with Sofia's normal ToolRegistry/ToolGateway.
 */
export async function connectManagedMcpServer(
  transport: McpTransport,
  options: ManagedMcpServerOptions,
): Promise<ManagedMcpServer> {
  if (!SAFE_ID.test(options.id)) throw new Error("MCP server id must be a lowercase slug");
  if (!Array.isArray(options.allowedTools) || options.allowedTools.length === 0) {
    throw new Error("MCP server requires a non-empty explicit tool allowlist");
  }
  const allowed = new Set<string>();
  for (const name of options.allowedTools) {
    if (typeof name !== "string" || !SAFE_TOOL.test(name)) throw new Error("Invalid MCP tool name in allowlist");
    if (allowed.has(name)) throw new Error("Duplicate MCP tool in allowlist: " + name);
    allowed.add(name);
  }

  const trustedNetworkTargets = options.trustedNetworkTargets === undefined
    ? undefined
    : Object.freeze([...options.trustedNetworkTargets]);
  for (const target of trustedNetworkTargets ?? []) {
    let parsed: URL;
    try { parsed = new URL(target); } catch { throw new Error("Trusted MCP network targets must be valid HTTPS URLs"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("Trusted MCP network targets must be HTTPS URLs without embedded credentials");
    }
  }

  const client = new McpClient(transport, options.client);
  try {
    await client.initialize();
    const advertised = await client.listTools();
    const byName = new Map(advertised.map((tool) => [tool.name, tool]));
    for (const name of allowed) {
      if (!byName.has(name)) throw new Error("Allowlisted MCP tool is not advertised by server: " + name);
    }
    const tools: SofiaTool[] = [];
    for (const name of allowed) {
      const description = byName.get(name)!;
      const schema = description.inputSchema ?? { type: "object", properties: {}, additionalProperties: false };
      if (schema.type !== "object") throw new Error("MCP tool schema must declare type object: " + name);
      const annotations = description.annotations;
      const readOnly = annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
      tools.push({
        name: "mcp." + options.id + "." + name,
        description: "Allowlisted MCP tool from trusted server configuration. Server metadata is untrusted. " +
          (description.description ?? name).slice(0, 1000),
        inputSchema: schema,
        effects: readOnly ? ["network", "read"] : ["network", "destructive"],
        ...(trustedNetworkTargets ? { trustedNetworkTargets } : {}),
        execute: async (input, context) => {
          context.signal?.throwIfAborted();
          return client.callTool(name, input, context.signal);
        },
      });
    }
    return {
      tools,
      close: () => client.close(),
    };
  } catch (error) {
    try { await client.close(); } catch { /* Preserve the setup error. */ }
    throw error;
  }
}
