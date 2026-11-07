import test from "node:test";
import assert from "node:assert/strict";
import { loadManagedMcpServersFromEnv } from "./env-config.js";

test("MCP runtime bootstrap is disabled without explicit operator configuration", () => {
  assert.deepEqual(loadManagedMcpServersFromEnv(""), []);
});

test("MCP runtime bootstrap requires stdio transport and explicit tool allowlists", () => {
  assert.throws(() => loadManagedMcpServersFromEnv(JSON.stringify([{ id: "x", transport: "http", endpoint: "https://example.com", allowedTools: ["read"] }])), /transport=stdio/);
  assert.throws(() => loadManagedMcpServersFromEnv(JSON.stringify([{ id: "x", transport: "stdio", command: "node" }])), /allowedTools/);
  assert.throws(() => loadManagedMcpServersFromEnv(JSON.stringify([{ id: "x", transport: "stdio", command: "node", allowedTools: ["read"] }, { id: "x", transport: "stdio", command: "node", allowedTools: ["read"] }])), /Duplicate MCP server id/);
});

test("MCP runtime bootstrap rejects unknown properties and malformed env", () => {
  assert.throws(() => loadManagedMcpServersFromEnv(JSON.stringify([{ id: "x", transport: "stdio", command: "node", allowedTools: ["read"], autoInstall: true }])), /unsupported property/);
  assert.throws(() => loadManagedMcpServersFromEnv(JSON.stringify([{ id: "x", transport: "stdio", command: "node", allowedTools: ["read"], env: { TOKEN: 123 } }])), /only string values/);
});
