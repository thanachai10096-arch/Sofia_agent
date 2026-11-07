import assert from "node:assert/strict";
import test from "node:test";
import { connectN8nOfficialMcp } from "./n8n-mcp.js";
import { defaultPolicy } from "../../security/policy.js";
import type { McpTransport } from "../../mcp/client.js";

function fakeTransport(): McpTransport & { closed: boolean } {
  return {
    closed: false,
    async request(method) {
      if (method === "initialize") return { protocolVersion: "2025-03-26", serverInfo: { name: "n8n", version: "1" } };
      if (method === "tools/list") return { tools: [{ name: "get_workflow", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] };
      throw new Error("unexpected method");
    },
    async notify() {},
    async close() { this.closed = true; },
  };
}
const env = { SOFIA_N8N_MCP_ENABLED: "true", SOFIA_N8N_MCP_URL: "https://automation.example.com/mcp-server/http", SOFIA_N8N_MCP_BEARER_TOKEN: "abc", SOFIA_N8N_MCP_ALLOWED_TOOLS: "get_workflow" };
const policy = { ...defaultPolicy, allowNetwork: true, allowedHosts: ["automation.example.com"] };

test("n8n MCP stays disabled by default", async () => {
  assert.equal(await connectN8nOfficialMcp({}, defaultPolicy, () => { throw new Error("unexpected transport"); }), undefined);
});
test("n8n MCP enforces HTTPS and an explicit allowlist", async () => {
  await assert.rejects(connectN8nOfficialMcp({ ...env, SOFIA_N8N_MCP_URL: "http://automation.example.com/mcp" }, policy), /HTTPS endpoint/);
  await assert.rejects(connectN8nOfficialMcp({ ...env, SOFIA_N8N_MCP_ALLOWED_TOOLS: "" }, policy), /explicitly list/);
});
test("n8n MCP requires Sofia network policy and host allowlisting", async () => {
  await assert.rejects(connectN8nOfficialMcp(env, defaultPolicy), /SOFIA_ALLOW_TOOLS=true/);
  await assert.rejects(connectN8nOfficialMcp(env, { ...defaultPolicy, allowNetwork: true }), /SOFIA_ALLOWED_HOSTS/);
});
test("n8n MCP registers only allowlisted tools with fixed trusted target", async () => {
  const transport = fakeTransport();
  const connected = await connectN8nOfficialMcp(env, policy, () => transport);
  assert.deepEqual(connected?.tools.map((tool) => tool.name), ["mcp.n8n.get_workflow"]);
  assert.deepEqual(connected?.tools[0]?.trustedNetworkTargets, [env.SOFIA_N8N_MCP_URL]);
  await connected?.close();
  assert.equal(transport.closed, true);
});
