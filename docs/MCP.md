# MCP integration

Sofia exposes an opt-in MCP client that adapts remote MCP tools into Sofia's existing tool format. The adapter does not execute tools directly: register the returned SofiaTool array with the existing Tool Registry so the normal Tool Gateway, policy, approval, and audit path remains authoritative.

## Transports

- stdio launches an explicitly configured command. Only a small environment-variable allowlist is inherited by default; pass additional variables explicitly. Only connect to MCP servers whose commands and packages you trust.
- HTTP uses an explicitly configured HTTP(S) endpoint and optional headers. Do not embed credentials in endpoint URLs. Configure host allowlists and network egress restrictions at the deployment boundary; the transport is not an SSRF defense.

## Example

    import { McpClient } from "sofia-agent";
    import { McpStdioTransport } from "sofia-agent";

    const transport = new McpStdioTransport({
      command: "node",
      args: ["./trusted-mcp-server.js"],
      env: { MCP_MODE: "read-only" },
    });
    const client = new McpClient(transport);
    await client.initialize();
    const tools = await client.createSofiaTools();
    // Register tools with Sofia's existing registry; do not call them outside ToolGateway.

## Security and limitations

- Server-provided names, descriptions, schemas, annotations, tool results, and resource contents are untrusted.
- Remote MCP tools are marked network-capable. Non-read-only tools are additionally marked destructive, so default policy may deny them until an operator configures appropriate permissions.
- Keep credentials out of source control and logs. Do not pass the master Sofia API key to an MCP server.
- The HTTP transport handles request/response JSON and SSE responses, not long-lived server-initiated notifications or subscription streaming.
- This is a client foundation; it does not implement an MCP server endpoint, marketplace, or automatic installation of servers.

## n8n official instance-level MCP (opt-in)

Sofia can attach selected tools from an operator-managed n8n instance to the existing tool registry. The integration is disabled by default and does not replace Sofia Brain, jobs, memory, or native tools.

1. In n8n, an owner/admin enables **Settings → Instance-level MCP** and copies the Server URL ending in `/mcp-server/http` (not the editor URL).
2. Configure `SOFIA_N8N_MCP_ENABLED=true`, `SOFIA_N8N_MCP_URL`, `SOFIA_N8N_MCP_BEARER_TOKEN`, and an explicit comma-separated `SOFIA_N8N_MCP_ALLOWED_TOOLS`.
3. Set `SOFIA_ALLOW_TOOLS=true`, `SOFIA_ALLOW_NETWORK=true`, and include the endpoint hostname in `SOFIA_ALLOWED_HOSTS`.
4. Restart Sofia. The connector validates the server's advertised tools against the exact allowlist and registers them under `mcp.n8n.<tool>`.

The endpoint is operator-configured and hash-bound as a trusted network target; the model cannot supply or change the destination URL. Tool input still passes through Sofia's JSON-schema validation, network policy, approval handler, audit path, and kill switch. Tools not explicitly allowlisted are never exposed. Missing approval wiring fails closed for actions that require approval.

**Authentication limitation:** this initial adapter accepts a manually provisioned bearer token only. It does not yet implement Hermes' browser OAuth flow, OAuth client registration, refresh-token rotation, or reauthorization UI. Do not describe this as full Hermes parity. Keep the bearer secret in the deployment secret store and never commit it. The integration remains off by default until the operator has configured and tested the endpoint.

**Execution limitation:** the MCP connector exposes selected n8n MCP tools directly. It does not yet route workflow dispatch through the durable Workflow Execution Ledger, so do not use it for high-impact or non-idempotent workflow dispatch until the ledger-backed WorkflowEngine adapter and provider-side reconciliation are implemented. Prefer read-only n8n tools in this phase.
