import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpServersConfig } from "./env.js";

test("MCP environment config accepts explicit stdio and HTTPS servers", () => {
  const servers = parseMcpServersConfig(JSON.stringify([
    { id: "local-tools", transport: "stdio", command: "node", args: ["server.js"], allowedTools: ["read_file"] },
    { id: "remote-docs", transport: "http", endpoint: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer test-secret" }, allowedTools: ["search"] },
  ]));
  assert.equal(servers.length, 2);
  assert.equal(servers[0]?.transport, "stdio");
  assert.equal(servers[1]?.transport, "http");
});

test("MCP environment config rejects duplicate ids and empty tool allowlists", () => {
  assert.throws(() => parseMcpServersConfig(JSON.stringify([
    { id: "docs", transport: "stdio", command: "node", allowedTools: ["search"] },
    { id: "docs", transport: "stdio", command: "node", allowedTools: ["read"] },
  ])), /duplicate server ids/);
  assert.throws(() => parseMcpServersConfig(JSON.stringify([
    { id: "docs", transport: "stdio", command: "node", allowedTools: [] },
  ])), /allowedTools/);
});

test("MCP environment config rejects unknown fields, malformed transports, and oversized config", () => {
  assert.throws(() => parseMcpServersConfig(JSON.stringify([
    { id: "docs", transport: "stdio", command: "node", allowedTools: ["search"], shell: true },
  ])), /unknown field/);
  assert.throws(() => parseMcpServersConfig(JSON.stringify([
    { id: "docs", transport: "http", endpoint: "http://mcp.example.com", allowedTools: ["search"] },
  ])), /transport/);
  assert.throws(() => parseMcpServersConfig("x".repeat(32_769)), /32 KiB/);
});
