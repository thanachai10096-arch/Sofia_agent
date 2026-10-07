export type ToolEffect = "read" | "write" | "shell" | "network" | "destructive" | "browser";

export interface ToolPermission {
  allow?: boolean;
  requireApproval?: boolean;
}

export interface ExecutionPolicy {
  allowTools: boolean;
  allowNetwork: boolean;
  allowShell: boolean;
  allowFileWrite: boolean;
  allowBrowser: boolean;
  maxSteps: number;
  maxToolCallsPerStep: number;
  permissions: Record<string, ToolPermission>;
}

export const defaultPolicy: ExecutionPolicy = {
  allowTools: true,
  allowNetwork: false,
  allowShell: false,
  allowFileWrite: true,
  allowBrowser: false,
  maxSteps: 12,
  maxToolCallsPerStep: 4,
  permissions: {},
};

export function loadExecutionPolicyFromEnv(): ExecutionPolicy {
  const bool = (name: string, fallback: boolean) =>
    process.env[name] === undefined ? fallback : process.env[name] === "true";
  const num = (name: string, fallback: number) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    ...defaultPolicy,
    allowTools: bool("SOFIA_ALLOW_TOOLS", defaultPolicy.allowTools),
    allowNetwork: bool("SOFIA_ALLOW_NETWORK", defaultPolicy.allowNetwork),
    allowShell: bool("SOFIA_ALLOW_SHELL", defaultPolicy.allowShell),
    allowFileWrite: bool("SOFIA_ALLOW_FILE_WRITE", defaultPolicy.allowFileWrite),
    allowBrowser: bool("SOFIA_ALLOW_BROWSER", defaultPolicy.allowBrowser),
    maxSteps: Math.min(num("SOFIA_MAX_STEPS", defaultPolicy.maxSteps), 50),
    maxToolCallsPerStep: Math.min(
      num("SOFIA_MAX_TOOL_CALLS_PER_STEP", defaultPolicy.maxToolCallsPerStep),
      16,
    ),
    permissions: defaultPolicy.permissions,
  };
}

export function assertSafeStep(policy: ExecutionPolicy, step: number): void {
  if (step > policy.maxSteps) throw new Error("Agent step limit exceeded");
}

export function toolPermission(
  policy: ExecutionPolicy,
  name: string,
  effects: readonly ToolEffect[],
): ToolPermission {
  const override = policy.permissions[name] ?? {};
  if (override.allow === false) return override;
  if (effects.includes("shell") && !policy.allowShell) return { allow: false };
  if (effects.includes("write") && !policy.allowFileWrite) return { allow: false };
  if (effects.includes("network") && !policy.allowNetwork) return { allow: false };
  if (effects.includes("browser") && !policy.allowBrowser) return { allow: false };
  return override;
}

export function assertToolAllowed(
  policy: ExecutionPolicy,
  name: string,
  effects: readonly ToolEffect[] = [],
): void {
  if (!policy.allowTools) throw new Error("Tool execution is disabled by policy.");
  const permission = toolPermission(policy, name, effects);
  if (permission.allow === false) {
    throw new Error(`Tool execution is disabled by policy: ${name}`);
  }
}
