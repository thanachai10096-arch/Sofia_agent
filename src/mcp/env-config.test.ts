import assert from "node:assert/strict";
import test from "node:test";
import { loadMcpServerConfigsFromEnv } from "./env-config.js";

test("MCP environment config is optional and defaults to no servers", () => {
  assert.deepEqual(loadMcpServerConfigsFromEnv({}), []);
  assert.deepEqual(loadMcpServerConfigsFromEnv({ SOFIA_MCP_SERVERS_JSON: "  " }), []);
});

test("MCP environment config rejects malformed JSON and non-array roots", () => {
  assert.throws(() => loadMcpServerConfigsFromEnv({ SOFIA_MCP_SERVERS_JSON: "{" }), /valid JSON/);
  assert.throws(() => loadMcpServerConfigsFromEnv({ SOFIA_MCP_SERVERS_JSON: "{}" }), /JSON array/);
});

test("MCP environment config constructs an explicit HTTP server and tool allowlist", () => {
  const configs = loadMcpServerConfigsFromEnv({
    SOFIA_MCP_SERVERS_JSON: JSON.stringify([{
      id: "docs",
      allowedTools: ["lookup"],
      transport: { type: "http", endpoint: "https://mcp.example.com/rpc", headers: { authorization: "Bearer test-token" } },
    }]),
  });
  assert.equal(configs.length, 1);
  assert.deepEqual(configs[0].options, { id: "docs", allowedTools: ["lookup"] });
  assert.equal(configs[0].transport.constructor.name, "McpHttpTransport");
});

test("MCP environment config requires an explicit tool allowlist", () => {
  assert.throws(() => loadMcpServerConfigsFromEnv({
    SOFIA_MCP_SERVERS_JSON: JSON.stringify([{
      id: "docs",
      allowedTools: [],
      transport: { type: "http", endpoint: "https://mcp.example.com/rpc" },
    }]),
  }), /non-empty allowedTools/);
});

test("MCP environment config rejects unsupported transport types", () => {
  assert.throws(() => loadMcpServerConfigsFromEnv({
    SOFIA_MCP_SERVERS_JSON: JSON.stringify([{
      id: "docs",
      allowedTools: ["lookup"],
      transport: { type: "websocket", endpoint: "wss://mcp.example.com" },
    }]),
  }), /stdio or http/);
});
