import type { SofiaTool } from "../../tools/types.js";

/**
 * Sofia's in-process plugin host.
 *
 * Inspired by Cordis composition: explicit plugin identity, scoped registration,
 * reversible effects, and lifecycle events. Sofia's Agent, Tool Gateway,
 * security policy, and tenant boundary remain the execution authority.
 */
export interface SofiaPluginEventMap {
  "plugin:installed": { pluginId: string };
  "plugin:uninstalled": { pluginId: string };
}

export type SofiaPluginEventName = keyof SofiaPluginEventMap;
export type SofiaPluginEventListener<K extends SofiaPluginEventName> =
  (payload: SofiaPluginEventMap[K]) => void;

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
  private readonly listeners = new Map<SofiaPluginEventName, Set<(payload: never) => void>>();
  private disposed = false;

  on<K extends SofiaPluginEventName>(
    event: K,
    listener: SofiaPluginEventListener<K>,
  ): () => void {
    this.assertActive();
    const listeners = this.listeners.get(event) ?? new Set<(payload: never) => void>();
    listeners.add(listener as (payload: never) => void);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as (payload: never) => void);
  }

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
      this.runDisposers(installed);
      throw error;
    }
    this.emit("plugin:installed", { pluginId: plugin.id });
  }

  unuse(pluginId: string): boolean {
    this.assertActive();
    const installed = this.plugins.get(pluginId);
    if (!installed) return false;
    this.plugins.delete(pluginId);
    try {
      this.runDisposers(installed);
    } finally {
      this.emit("plugin:uninstalled", { pluginId });
    }
    return true;
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
    const errors: unknown[] = [];
    for (const plugin of installed) {
      try {
        this.runDisposers(plugin);
      } catch (error) {
        errors.push(error);
      }
      this.emit("plugin:uninstalled", { pluginId: plugin.id });
    }
    this.services.clear();
    this.tools.clear();
    this.listeners.clear();
    this.disposed = true;
    if (errors.length) throw new AggregateError(errors, "One or more Sofia plugins failed to dispose.");
  }

  private runDisposers(plugin: InstalledPlugin): void {
    const errors: unknown[] = [];
    for (const dispose of plugin.disposers.reverse()) {
      try { dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Plugin "${plugin.id}" cleanup failed.`);
  }

  private emit<K extends SofiaPluginEventName>(event: K, payload: SofiaPluginEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try { listener(payload as never); } catch {
        // Observers must not break plugin installation or teardown.
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Sofia plugin host has been disposed.");
  }
}

/** Create a fresh host for one Sofia dependency composition. */
export function createSofiaPluginHost(): SofiaPluginHost {
  return new SofiaPluginHost();
}
