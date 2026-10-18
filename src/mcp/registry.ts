import type { SofiaTool, ToolRegistry } from "../tools/types.js";
import { createToolRegistry } from "../tools/registry.js";
import type { McpTransport } from "./client.js";
import { connectManagedMcpServer, type ManagedMcpServerOptions } from "./managed-server.js";

export interface ManagedMcpServerConfig {
  transport: McpTransport;
  options: ManagedMcpServerOptions;
}

export interface ManagedMcpToolRegistry {
  tools: ToolRegistry;
  close(): Promise<void>;
}

/**
 * Explicit async bootstrap for trusted, operator-configured MCP transports.
 * Every resulting tool remains behind Sofia's ordinary ToolGateway policy and approval checks.
 */
export async function connectManagedMcpRegistry(
  baseTools: readonly SofiaTool[],
  servers: readonly ManagedMcpServerConfig[],
): Promise<ManagedMcpToolRegistry> {
  const names = new Set<string>();
  for (const tool of baseTools) {
    if (names.has(tool.name)) throw new Error("Duplicate base tool name: " + tool.name);
    names.add(tool.name);
  }

  const connected: Array<{ close(): Promise<void>; tools: SofiaTool[] }> = [];
  try {
    for (const config of servers) {
      const server = await connectManagedMcpServer(config.transport, config.options);
      connected.push(server);
      for (const tool of server.tools) {
        if (names.has(tool.name)) throw new Error("Duplicate registered tool name: " + tool.name);
        names.add(tool.name);
      }
    }
    const tools = createToolRegistry([...baseTools, ...connected.flatMap((server) => server.tools)]);
    return {
      tools,
      async close() {
        const errors: unknown[] = [];
        for (const server of [...connected].reverse()) {
          try { await server.close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, "One or more MCP servers failed to close");
      },
    };
  } catch (error) {
    for (const server of [...connected].reverse()) {
      try { await server.close(); } catch { /* Preserve the setup error. */ }
    }
    throw error;
  }
}
