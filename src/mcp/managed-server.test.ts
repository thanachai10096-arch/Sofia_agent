import assert from "node:assert/strict";
import test from "node:test";
import { connectManagedMcpServer } from "./managed-server.js";
import type { McpTransport } from "./client.js";

function fakeTransport(advertised = [{ name: "lookup", description: "Find records", inputSchema: {
  type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
}, annotations: { readOnlyHint: true } }]): McpTransport & { calls: string[]; closed: boolean } {
  const calls: string[] = [];
  return {
    calls,
    closed: false,
    async request(method, params) {
      calls.push(method);
      if (method === "initialize") return { protocolVersion: "2025-03-26", serverInfo: { name: "untrusted", version: "1" } };
      if (method === "tools/list") return { tools: advertised };
      if (method === "tools/call") return { content: [{ type: "text", text: JSON.stringify(params) }] };
      throw new Error("unexpected method " + method);
    },
    async notify() {},
    async close() { this.closed = true; },
  };
}

test("managed MCP bridge exposes only allowlisted namespaced tools", async () => {
  const transport = fakeTransport();
  const connected = await connectManagedMcpServer(transport, { id: "docs", allowedTools: ["lookup"] });
  assert.deepEqual(connected.tools.map((tool) => tool.name), ["mcp.docs.lookup"]);
  assert.deepEqual(connected.tools[0]?.effects, ["network", "read"]);
  const result = await connected.tools[0]!.execute({ query: "hello" }, { runtime: {} as never });
  assert.match(JSON.stringify(result), /"query":"hello"/);
  await connected.close();
  assert.equal(transport.closed, true);
});

test("managed MCP bridge requires an explicit allowlist", async () => {
  const transport = fakeTransport();
  await assert.rejects(connectManagedMcpServer(transport, { id: "docs", allowedTools: [] }), /explicit tool allowlist/);
  assert.equal(transport.calls.length, 0);
});

test("managed MCP bridge closes transport when allowlist does not match server", async () => {
  const transport = fakeTransport();
  await assert.rejects(connectManagedMcpServer(transport, { id: "docs", allowedTools: ["delete"] }), /not advertised/);
  assert.equal(transport.closed, true);
});

test("managed MCP bridge rejects unsafe namespace", async () => {
  const transport = fakeTransport();
  await assert.rejects(connectManagedMcpServer(transport, { id: "../docs", allowedTools: ["lookup"] }), /lowercase slug/);
  assert.equal(transport.calls.length, 0);
});
