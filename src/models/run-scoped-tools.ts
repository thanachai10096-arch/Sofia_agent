import { createBrowserTools, type BrowserToolOptions } from "../browser/tools.js";
import type { BrowserRuntime } from "../browser/runtime.js";
import { createDesktopTools } from "../desktop/tools.js";
import { DesktopRuntime, createDesktopPrincipal } from "../desktop/runtime.js";
import type { DesktopCapability } from "../desktop/types.js";
import { createToolRegistry } from "../tools/registry.js";
import type { SofiaTool, ToolRegistry } from "../tools/types.js";

export interface RunScopedToolRegistryOptions {
  baseTools: readonly SofiaTool[];
  allowBrowser: boolean;
  browserRuntime: BrowserRuntime;
  browserOptions?: BrowserToolOptions;
  desktopCapabilities?: readonly DesktopCapability[];
  principalId?: string;
  workspaceRoot: string;
  allowedExecutables?: readonly string[];
}

export interface RunScopedToolRegistry {
  registry: ToolRegistry;
  cleanup(): Promise<void>;
}

/**
 * Compose isolated Browser tools and authenticated Desktop tools for one Brain
 * run. Browser handles are always cleaned up when the run ends; Desktop grants
 * come only from the trusted host and never from model-generated input.
 */
export function createRunScopedToolRegistry(options: RunScopedToolRegistryOptions): RunScopedToolRegistry {
  const browserCleanups: Array<() => Promise<void>> = [];
  const browserTools = options.allowBrowser
    ? createBrowserTools(options.browserRuntime, (cleanup) => browserCleanups.push(cleanup), options.browserOptions)
    : [];
  const capabilities = options.desktopCapabilities ?? [];
  const desktopTools = capabilities.length
    ? createDesktopTools({
        runtime: new DesktopRuntime({
          workspaceRoot: options.workspaceRoot,
          allowedExecutables: options.allowedExecutables ?? [],
        }),
        principal: createDesktopPrincipal(options.principalId ?? "local-agent", capabilities),
      })
    : [];

  return {
    registry: createToolRegistry([...options.baseTools, ...browserTools, ...desktopTools]),
    async cleanup() {
      await Promise.allSettled(browserCleanups.map((cleanup) => cleanup()));
    },
  };
}
