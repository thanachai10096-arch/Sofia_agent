import type { TaskKind } from "../models/types.js";

export type SofiaPlatform = "windows" | "macos" | "linux";

export interface WorkspaceRuntime {
  readonly platform: SofiaPlatform;
  cwd(): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path?: string): Promise<string[]>;
  search(query: string, path?: string): Promise<string[]>;
  run(command: string, args?: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string; code: number }>;
  git(args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string; code: number }>;
}

export function detectPlatform(): SofiaPlatform {
  switch (process.platform) {
    case "win32": return "windows";
    case "darwin": return "macos";
    default: return "linux";
  }
}

export function runtimeForCurrentPlatform(): WorkspaceRuntime {
  throw new Error(
    "No local runtime installed. Use createNodeWorkspaceRuntime() from local-runtime or provide a custom WorkspaceRuntime."
  );
}
