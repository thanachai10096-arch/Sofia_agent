export type DesktopCapability =
  | "system:discover"
  | "workspace:list"
  | "workspace:read"
  | "workspace:write"
  | "process:execute"
  | "screen:capture"
  | "app:launch"
  | "input:control";

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


/** Platform-native implementation supplied by the trusted local desktop host. */
export interface DesktopHostDriver {
  captureScreen(options?: { displayId?: string }): Promise<{ mimeType: "image/png" | "image/jpeg"; data: Uint8Array; width: number; height: number }>;
  launchApplication(applicationId: string, args?: string[]): Promise<{ launched: boolean; applicationId: string }>;
  click(point: { x: number; y: number; button?: "left" | "right" | "middle" }): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
}

export type DesktopAction =
  | { kind: "app.launch"; applicationId: string; args: string[] }
  | { kind: "input.click"; x: number; y: number; button: "left" | "right" | "middle" }
  | { kind: "input.type"; text: string }
  | { kind: "input.key"; key: string };

export interface DesktopAdapterConfig {
  driver: DesktopHostDriver;
  /** Must be a real user-facing approval prompt; model text cannot approve actions. */
  requestApproval: (action: DesktopAction) => Promise<boolean>;
  /** Exact app identifiers the local operator permits the host to launch. */
  allowedApplications?: readonly string[];
  maxTextLength?: number;
}
