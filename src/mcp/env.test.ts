import assert from "node:assert/strict";
import test from "node:test";
import { connectMcpFromEnv } from "./env.js";
import { defaultPolicy } from "../security/policy.js";
import { McpClient } from "./client.js";
import { McpHttpTransport } from "./transports.js";

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test("MCP bootstrap stays disabled when no server config is supplied", async () => {
  await withEnv({ SOFIA_MCP_SERVERS: undefined }, async () => {
    assert.equal(await connectMcpFromEnv(defaultPolicy), undefined);
  });
});

test("MCP bootstrap rejects malformed JSON and untrusted server definitions", async () => {
  await withEnv({ SOFIA_MCP_SERVERS: "{" }, async () => {
    await assert.rejects(connectMcpFromEnv(defaultPolicy), /valid JSON/);
  });
  await withEnv({ SOFIA_MCP_SERVERS: JSON.stringify([{ id: "docs", transport: "http", endpoint: "http://127.0.0.1/mcp", allowedTools: ["search"] }]) }, async () => {
    await assert.rejects(connectMcpFromEnv({ ...defaultPolicy, allowNetwork: true, allowedHosts: ["127.0.0.1"] }), /must use HTTPS/);
  });
});

test("MCP HTTP servers require explicit network permission and exact host allowlisting", async () => {
  const config = JSON.stringify([{ id: "docs", transport: "http", endpoint: "https://mcp.example.com/mcp", allowedTools: ["search"] }]);
  await withEnv({ SOFIA_MCP_SERVERS: config }, async () => {
    await assert.rejects(connectMcpFromEnv(defaultPolicy), /blocked/);
    await assert.rejects(connectMcpFromEnv({ ...defaultPolicy, allowNetwork: true, allowedHosts: ["other.example.com"] }), /blocked/);
  });
});

test("MCP stdio commands require an operator allowlist", async () => {
  const config = JSON.stringify([{ id: "local", transport: "stdio", command: "node", args: ["server.js"], allowedTools: ["lookup"] }]);
  await withEnv({ SOFIA_MCP_SERVERS: config, SOFIA_MCP_STDIO_ALLOWED_COMMANDS: "" }, async () => {
    await assert.rejects(connectMcpFromEnv(defaultPolicy), /not in SOFIA_MCP_STDIO_ALLOWED_COMMANDS/);
  });
});

test("MCP bootstrap rejects readOnlyTools outside the explicit allowedTools list", async () => {
  const config = JSON.stringify([{
    id: "docs", transport: "http", endpoint: "https://mcp.example.com/mcp",
    allowedTools: ["search"], readOnlyTools: ["delete"],
  }]);
  await withEnv({ SOFIA_MCP_SERVERS: config }, async () => {
    await assert.rejects(connectMcpFromEnv(defaultPolicy), /readOnlyTools must be a subset/);
  });
});

test("MCP HTTP transport sends the server-negotiated protocol version after initialize", async () => {
  const requests: Array<{ method: string; protocolVersion: string | null }> = [];
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    const headers = new Headers(init.headers);
    const method = init.method === "DELETE"
      ? "session/delete"
      : (JSON.parse(String(init.body)) as { method: string }).method;
    requests.push({ method, protocolVersion: headers.get("mcp-protocol-version") });
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "session/delete") return new Response(null, { status: 200 });
    const request = JSON.parse(String(init.body)) as { id: string | number };
    const result = method === "initialize"
      ? { protocolVersion: "2025-03-26", serverInfo: { name: "test-server", version: "1" } }
      : { tools: [] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const transport = new McpHttpTransport({ endpoint: "https://mcp.example.com/mcp", fetchImpl });
  const client = new McpClient(transport);
  await client.initialize();
  await client.listTools();
  await client.close();
  assert.deepEqual(requests, [
    { method: "initialize", protocolVersion: null },
    { method: "notifications/initialized", protocolVersion: "2025-03-26" },
    { method: "tools/list", protocolVersion: "2025-03-26" },
  ]);
});
