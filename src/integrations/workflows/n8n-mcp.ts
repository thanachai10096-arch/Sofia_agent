import type { ManagedMcpServer } from "../../mcp/managed-server.js";
import { connectManagedMcpServer } from "../../mcp/managed-server.js";
import { McpHttpTransport } from "../../mcp/transports.js";
import type { ExecutionPolicy } from "../../security/policy.js";
import type { McpTransport } from "../../mcp/client.js";

export interface N8nMcpEnvironment {
  SOFIA_N8N_MCP_ENABLED?: string;
  SOFIA_N8N_MCP_URL?: string;
  SOFIA_N8N_MCP_BEARER_TOKEN?: string;
  SOFIA_N8N_MCP_ALLOWED_TOOLS?: string;
}

function parseAllowedTools(value: string | undefined): string[] {
  const names = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("SOFIA_N8N_MCP_ALLOWED_TOOLS must explicitly list at least one tool");
  if (new Set(names).size !== names.length) throw new Error("SOFIA_N8N_MCP_ALLOWED_TOOLS contains duplicate names");
  return names;
}

/**
 * Optional connection to n8n's official instance-level MCP HTTP endpoint.
 *
 * This first adapter deliberately supports a manually provisioned bearer token only.
 * Browser OAuth/token refresh is not implemented yet; do not mistake this for Hermes'
 * full OAuth experience. Disabled unless explicitly enabled and fully configured.
 */
export async function connectN8nOfficialMcp(
  env: N8nMcpEnvironment,
  policy: ExecutionPolicy,
  transportFactory: (endpoint: string, token: string) => McpTransport = (endpoint, token) => new McpHttpTransport({
    endpoint,
    headers: { Authorization: "Bearer " + token },
  }),
): Promise<ManagedMcpServer | undefined> {
  if (env.SOFIA_N8N_MCP_ENABLED !== "true") return undefined;
  const endpoint = env.SOFIA_N8N_MCP_URL?.trim();
  const token = env.SOFIA_N8N_MCP_BEARER_TOKEN?.trim();
  if (!endpoint || !token) throw new Error("n8n MCP requires SOFIA_N8N_MCP_URL and SOFIA_N8N_MCP_BEARER_TOKEN");
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SOFIA_N8N_MCP_URL must be an HTTPS endpoint without credentials, query, or fragment");
  }
  if (!policy.allowTools || !policy.allowNetwork) {
    throw new Error("n8n MCP requires SOFIA_ALLOW_TOOLS=true and SOFIA_ALLOW_NETWORK=true");
  }
  if (!policy.allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error("n8n MCP host must be included in SOFIA_ALLOWED_HOSTS");
  }
  const allowedTools = parseAllowedTools(env.SOFIA_N8N_MCP_ALLOWED_TOOLS);
  return connectManagedMcpServer(transportFactory(parsed.toString(), token), {
    id: "n8n",
    allowedTools,
    trustedNetworkTargets: [parsed.toString()],
    client: { name: "sofia-agent", version: "0.3.0" },
  });
}
