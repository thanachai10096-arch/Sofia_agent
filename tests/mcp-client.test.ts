import test from "node:test";
import assert from "node:assert/strict";
import { McpClient, type McpTransport } from "../src/mcp/client.js";

class FakeTransport implements McpTransport {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "initialize") return { protocolVersion: "2025-03-26", serverInfo: { name: "test", version: "1" }, capabilities: { tools: {} } };
    if (method === "tools/list") return { tools: [{ name: "read_status", description: "Read status", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] };
    if (method === "tools/call") return { content: [{ type: "text", text: "ok" }], isError: false };
    if (method === "resources/list") return { resources: [{ uri: "test://resource", name: "fixture" }] };
    if (method === "resources/read") return { contents: [{ uri: String((params as { uri: string }).uri), text: "fixture" }] };
    throw new Error("unexpected method");
  }
  async notify(method: string): Promise<void> { this.calls.push({ method }); }
  async close(): Promise<void> { this.calls.push({ method: "close" }); }
}
test("MCP client requires initialization before listing tools", async () => {
  const client = new McpClient(new FakeTransport());
  await assert.rejects(client.listTools(), /initialized first/);
});
test("MCP client initializes, lists tools, and wraps them as gated Sofia tools", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport);
  await client.initialize();
  const tools = await client.createSofiaTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "mcp.read_status");
  assert.deepEqual(tools[0]?.effects, ["network", "read"]);
  const result = await tools[0]?.execute({}, { runtime: {} as never });
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }], isError: false });
  assert.ok(transport.calls.some((call) => call.method === "notifications/initialized"));
});
test("MCP client lists and reads resources", async () => {
  const client = new McpClient(new FakeTransport());
  await client.initialize();
  assert.equal((await client.listResources())[0]?.uri, "test://resource");
  assert.deepEqual(await client.readResource("test://resource"), { contents: [{ uri: "test://resource", text: "fixture" }] });
});
test("MCP client closes transport and rejects subsequent calls", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport);
  await client.close();
  await assert.rejects(client.initialize(), /closed/);
});
