import type { SofiaTool } from "../../tools/types.js";

/**
 * Sofia's in-process plugin host.
 *
 * This adopts the useful Cordis composition model (explicit plugin identity,
 * scoped registration, and reversible effects) while keeping Sofia's existing
 * Agent, Tool Gateway, security policy, and tenant boundary as the execution
 * authority. Plugins are code extensions, not independent agents or services.
 */
export interface SofiaPluginContext {
  readonly pluginId: string;
  registerTool(tool: SofiaTool): void;
  provideService<T>(name: string, service: T): void;
  getService<T>(name: string): T | undefined;
  onDispose(disposer: () => void): void;
}

export interface SofiaPlugin {
  readonly id: string;
  install(context: SofiaPluginContext): void;
}

interface InstalledPlugin {
  id: string;
  disposers: Array<() => void>;
}

export class SofiaPluginHost {
  private readonly plugins = new Map<string, InstalledPlugin>();
  private readonly tools = new Map<string, SofiaTool>();
  private readonly services = new Map<string, unknown>();
  private disposed = false;

  use(plugin: SofiaPlugin): void {
    this.assertActive();
    if (!plugin.id.trim()) throw new Error("Sofia plugin id must not be empty.");
    if (this.plugins.has(plugin.id)) throw new Error(`Sofia plugin "${plugin.id}" is already installed.`);

    const installed: InstalledPlugin = { id: plugin.id, disposers: [] };
    const context: SofiaPluginContext = {
      pluginId: plugin.id,
      registerTool: (tool) => {
        this.assertActive();
        if (!tool.name.trim()) throw new Error("Sofia plugin tool name must not be empty.");
        if (this.tools.has(tool.name)) throw new Error(`Sofia tool "${tool.name}" is already registered.`);
        this.tools.set(tool.name, tool);
        installed.disposers.push(() => this.tools.delete(tool.name));
      },
      provideService: <T>(name: string, service: T) => {
        this.assertActive();
        if (!name.trim()) throw new Error("Sofia plugin service name must not be empty.");
        if (this.services.has(name)) throw new Error(`Sofia service "${name}" is already provided.`);
        this.services.set(name, service);
        installed.disposers.push(() => this.services.delete(name));
      },
      getService: <T>(name: string) => this.services.get(name) as T | undefined,
      onDispose: (disposer) => {
        this.assertActive();
        installed.disposers.push(disposer);
      },
    };

    // Publish only after installation succeeds. Roll back partial registrations
    // in reverse order if a plugin fails halfway through installation.
    try {
      plugin.install(context);
      this.plugins.set(plugin.id, installed);
    } catch (error) {
      for (const dispose of installed.disposers.reverse()) {
        try { dispose(); } catch { /* preserve the original install error */ }
      }
      throw error;
    }
  }

  listTools(): SofiaTool[] {
    this.assertActive();
    return [...this.tools.values()];
  }

  listPlugins(): string[] {
    this.assertActive();
    return [...this.plugins.keys()];
  }

  dispose(): void {
    if (this.disposed) return;
    const installed = [...this.plugins.values()].reverse();
    this.plugins.clear();
    for (const plugin of installed) {
      for (const dispose of plugin.disposers.reverse()) dispose();
    }
    this.services.clear();
    this.tools.clear();
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Sofia plugin host has been disposed.");
  }
}

/** Create a fresh host for one Sofia dependency composition. */
export function createSofiaPluginHost(): SofiaPluginHost {
  return new SofiaPluginHost();
}
