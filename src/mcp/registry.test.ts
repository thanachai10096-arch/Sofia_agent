import assert from "node:assert/strict";
import test from "node:test";
import { connectManagedMcpRegistry } from "./registry.js";
import type { McpTransport } from "./client.js";
import type { SofiaTool } from "../tools/types.js";

function transport(): McpTransport & { closed: boolean } {
  return {
    closed: false,
    async request(method, params) {
      if (method === "initialize") return { protocolVersion: "2025-03-26", serverInfo: { name: "server", version: "1" } };
      if (method === "tools/list") return { tools: [{ name: "lookup", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] };
      if (method === "tools/call") return { content: [{ type: "text", text: JSON.stringify(params) }] };
      throw new Error("unexpected method " + method);
    },
    async notify() {},
    async close() { this.closed = true; },
  };
}

const baseTool: SofiaTool = {
  name: "base.echo",
  description: "Echo",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  effects: ["read"],
  async execute(input) { return input; },
};

test("managed MCP registry combines base and explicitly configured tools", async () => {
  const serverTransport = transport();
  const connected = await connectManagedMcpRegistry([baseTool], [
    { transport: serverTransport, options: { id: "docs", allowedTools: ["lookup"] } },
  ]);
  assert.deepEqual(connected.tools.list().map((tool) => tool.name), ["base.echo", "mcp.docs.lookup"]);
  assert.ok(connected.tools.get("mcp.docs.lookup"));
  await connected.close();
  assert.equal(serverTransport.closed, true);
});

test("managed MCP registry rejects collisions and closes already-connected servers", async () => {
  const serverTransport = transport();
  await assert.rejects(connectManagedMcpRegistry([{ ...baseTool, name: "mcp.docs.lookup" }], [
    { transport: serverTransport, options: { id: "docs", allowedTools: ["lookup"] } },
  ]), /Duplicate registered tool name/);
  assert.equal(serverTransport.closed, true);
});

test("managed MCP registry rejects duplicate base tool names", async () => {
  await assert.rejects(connectManagedMcpRegistry([baseTool, baseTool], []), /Duplicate base tool name/);
});
