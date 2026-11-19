import { createHash } from "node:crypto";
import { policyForToolScopes, type ExecutionPolicy } from "../security/policy.js";

export interface ApiScopeDescriptor {
  scope: string;
  category: "agent" | "memory" | "tools" | "desktop" | "security" | "cron";
  description: string;
  elevated: boolean;
}

/** Canonical scope inventory exposed to trusted administrators; unknown scopes remain inert. */
export const API_SCOPE_CATALOG: readonly ApiScopeDescriptor[] = [
  { scope: "agent:run", category: "agent", description: "Start and cancel agent runs and jobs", elevated: false },
  { scope: "agent:read", category: "agent", description: "Read this key's own run and job status", elevated: false },
  { scope: "memory:read", category: "memory", description: "Read this key's private memory", elevated: false },
  { scope: "memory:write", category: "memory", description: "Create, update, and clear this key's private memory", elevated: true },
  { scope: "tool:write", category: "tools", description: "Write or patch files in this key's workspace", elevated: true },
  { scope: "tool:shell", category: "tools", description: "Run shell and terminal commands", elevated: true },
  { scope: "tool:network", category: "tools", description: "Use network-enabled tools subject to host allowlists", elevated: true },
  { scope: "tool:browser", category: "tools", description: "Interact with browser sessions", elevated: true },
  { scope: "tool:destructive", category: "tools", description: "Perform destructive tool actions when host policy permits", elevated: true },
  { scope: "desktop:discover", category: "desktop", description: "Discover explicitly connected desktop capabilities", elevated: true },
  { scope: "desktop:workspace:list", category: "desktop", description: "List files in the connected desktop workspace", elevated: true },
  { scope: "desktop:workspace:read", category: "desktop", description: "Read files in the connected desktop workspace", elevated: true },
  { scope: "desktop:workspace:write", category: "desktop", description: "Write files in the connected desktop workspace", elevated: true },
  { scope: "desktop:process:execute", category: "desktop", description: "Execute processes through the connected desktop runtime", elevated: true },
  { scope: "security:admin", category: "security", description: "Read security status, audit, and permission inventory", elevated: true },
  { scope: "cron:read", category: "cron", description: "Read scheduled jobs", elevated: false },
  { scope: "cron:manage", category: "cron", description: "Create, change, and delete scheduled jobs", elevated: true },
] as const;

/** Return only hashed key identities; never return bearer tokens or mutable source objects. */
export function summarizeApiKeyPermissions(apiKeys: Record<string, string[]>, hostPolicy: ExecutionPolicy) {
  return Object.entries(apiKeys)
    .map(([token, scopes]) => ({
      keyId: createHash("sha256").update(token).digest("hex").slice(0, 32),
      scopes: [...new Set(scopes)].sort(),
      effectiveTools: {
        fileWrite: policyForToolScopes(hostPolicy, scopes).allowFileWrite,
        shell: policyForToolScopes(hostPolicy, scopes).allowShell,
        network: policyForToolScopes(hostPolicy, scopes).allowNetwork,
        browser: policyForToolScopes(hostPolicy, scopes).allowBrowser,
        destructive: policyForToolScopes(hostPolicy, scopes).allowDestructive,
      },
    }))
    .sort((a, b) => a.keyId.localeCompare(b.keyId));
}
