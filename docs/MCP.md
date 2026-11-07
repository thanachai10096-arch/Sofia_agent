# MCP integration

Sofia exposes an opt-in MCP client that adapts remote MCP tools into Sofia's existing tool format. The adapter does not execute tools directly: register the returned SofiaTool array with the existing Tool Registry so the normal Tool Gateway, policy, approval, and audit path remains authoritative.

The async `createSofiaAgentDependenciesWithSessions(workspace, approval, databasePath, mcpServers)` factory can now accept an explicit list of trusted `ManagedMcpServerConfig` entries. It connects them during startup and injects their allowlisted tools into every Brain run's Tool Registry. The returned dependencies expose `closeMcpServers()`; call it during graceful shutdown. Existing calls that omit `mcpServers` keep the previous behavior.

## Transports

- stdio launches an explicitly configured command. Only a small environment-variable allowlist is inherited by default; pass additional variables explicitly. Only connect to MCP servers whose commands and packages you trust.
- HTTP uses an explicitly configured HTTP(S) endpoint and optional headers. Do not embed credentials in endpoint URLs. Configure host allowlists and network egress restrictions at the deployment boundary; the transport is not an SSRF defense.

## Example

    import {
      createSofiaAgentDependenciesWithSessions,
      McpStdioTransport,
    } from "sofia-agent";

    const deps = await createSofiaAgentDependenciesWithSessions(
      process.cwd(),
      undefined,
      undefined,
      [{
        transport: new McpStdioTransport({
          command: "node",
          args: ["./trusted-mcp-server.js"],
          env: { MCP_MODE: "read-only" },
        }),
        options: { id: "docs", allowedTools: ["lookup"] },
      }],
    );
    // The allowlisted MCP tools are now in deps.tools and available to Brain.
    // On graceful shutdown, call await deps.closeMcpServers().

## Security and limitations

- Server-provided names, descriptions, schemas, annotations, tool results, and resource contents are untrusted.
- Remote MCP tools are marked network-capable. Non-read-only tools are additionally marked destructive, so default policy may deny them until an operator configures appropriate permissions.
- Keep credentials out of source control and logs. Do not pass the master Sofia API key to an MCP server.
- The HTTP transport handles request/response JSON and SSE responses, not long-lived server-initiated notifications or subscription streaming.
- This is a client foundation; it does not implement an MCP server endpoint, marketplace, or automatic installation of servers.
