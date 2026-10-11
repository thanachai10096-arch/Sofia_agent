export type DesktopCapability =
  | "system:discover"
  | "workspace:list"
  | "workspace:read"
  | "workspace:write"
  | "process:execute";

export interface DesktopPrincipal {
  id: string;
  capabilities: ReadonlySet<DesktopCapability>;
}

export interface DesktopRuntimeConfig {
  /** Existing directory that bounds all file operations and process working directories. */
  workspaceRoot: string;
  /** Exact executable names allowed for process execution. Empty by default. */
  allowedExecutables?: readonly string[];
  /** Maximum output bytes captured from a command. */
  maxOutputBytes?: number;
  /** Default process timeout. */
  commandTimeoutMs?: number;
}

export interface DesktopSystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  workspaceRoot: string;
  capabilities: DesktopCapability[];
}

export interface DesktopFileEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number;
  modifiedAt?: string;
}

export interface DesktopCommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
