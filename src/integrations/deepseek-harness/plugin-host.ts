import type { SofiaTool } from "../../tools/types.js";
import { effectiveToolEffects, type ToolEffect } from "../../security/policy.js";

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

export interface SofiaPluginManifest {
  readonly version: string;
  readonly description?: string;
  /** Effects explicitly declared by tools owned by this plugin. */
  readonly capabilities: readonly ToolEffect[];
  /** Plugin IDs that must already be installed before this plugin. */
  readonly dependencies?: readonly string[];
}

export interface SofiaPlugin {
  readonly id: string;
  readonly manifest?: SofiaPluginManifest;
  install(context: SofiaPluginContext): void;
}

interface InstalledPlugin {
  id: string;
  manifest?: SofiaPluginManifest;
  disposers: Array<() => void>;
}

export class SofiaPluginHost {
  private readonly plugins = new Map<string, InstalledPlugin>();
  private readonly tools = new Map<string, SofiaTool>();
  private readonly services = new Map<string, { pluginId: string; value: unknown }>();
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
    const manifest = plugin.manifest ? {
      ...plugin.manifest,
      capabilities: [...plugin.manifest.capabilities],
      dependencies: [...(plugin.manifest.dependencies ?? [])],
    } : undefined;
    if (manifest) {
      if (!manifest.version.trim()) throw new Error(`Sofia plugin "${plugin.id}" must declare a manifest version.`);
      const capabilities = new Set<ToolEffect>(manifest.capabilities);
      for (const dependency of manifest.dependencies ?? []) {
        if (dependency === plugin.id) throw new Error(`Sofia plugin "${plugin.id}" cannot depend on itself.`);
        if (!this.plugins.has(dependency)) throw new Error(`Sofia plugin "${plugin.id}" requires plugin "${dependency}" to be installed first.`);
      }
      for (const capability of capabilities) {
        if (!["read", "write", "shell", "network", "destructive", "browser"].includes(capability)) {
          throw new Error(`Sofia plugin "${plugin.id}" declares an unknown capability.`);
        }
      }
    }

    const installed: InstalledPlugin = { id: plugin.id, manifest, disposers: [] };
    const context: SofiaPluginContext = {
      pluginId: plugin.id,
      registerTool: (tool) => {
        this.assertActive();
        if (!tool.name.trim()) throw new Error("Sofia plugin tool name must not be empty.");
        if (this.tools.has(tool.name)) throw new Error(`Sofia tool "${tool.name}" is already registered.`);
        if (manifest) {
          // Validate inferred effects too: a plugin cannot omit tool.effects to
          // conceal a privileged action behind a read-only manifest.
          for (const effect of effectiveToolEffects(tool.name, tool.effects)) {
            if (!manifest.capabilities.includes(effect)) {
              throw new Error(`Sofia plugin "${plugin.id}" does not declare effective tool capability "${effect}" required by "${tool.name}".`);
            }
          }
        }
        const registeredTool: SofiaTool = Object.freeze({
          ...tool,
          ...(tool.effects ? { effects: Object.freeze([...tool.effects]) } : {}),
        });
        this.tools.set(tool.name, registeredTool);
        installed.disposers.push(() => this.tools.delete(tool.name));
      },
      provideService: <T>(name: string, service: T) => {
        this.assertActive();
        if (!name.trim()) throw new Error("Sofia plugin service name must not be empty.");
        if (this.services.has(name)) throw new Error(`Sofia service "${name}" is already provided.`);
        this.services.set(name, { pluginId: plugin.id, value: service });
        installed.disposers.push(() => this.services.delete(name));
      },
      getService: <T>(name: string) => {
        const entry = this.services.get(name);
        if (!entry) return undefined;
        if (entry.pluginId !== plugin.id && !(manifest?.dependencies ?? []).includes(entry.pluginId)) {
          throw new Error(`Sofia plugin "${plugin.id}" must declare "${entry.pluginId}" as a dependency to access service "${name}".`);
        }
        return entry.value as T;
      },
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
      try { this.runDisposers(installed); } catch { /* preserve the original install error */ }
      throw error;
    }
    this.emit("plugin:installed", { pluginId: plugin.id });
  }

  unuse(pluginId: string): boolean {
    this.assertActive();
    const installed = this.plugins.get(pluginId);
    if (!installed) return false;
    const dependent = [...this.plugins.values()].find((candidate) =>
      candidate.manifest?.dependencies?.includes(pluginId),
    );
    if (dependent) {
      throw new Error(`Cannot uninstall Sofia plugin "${pluginId}" while "${dependent.id}" depends on it.`);
    }
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

  getPluginManifest(pluginId: string): SofiaPluginManifest | undefined {
    this.assertActive();
    const manifest = this.plugins.get(pluginId)?.manifest;
    return manifest ? { ...manifest, capabilities: [...manifest.capabilities], dependencies: [...(manifest.dependencies ?? [])] } : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    // Close the host before invoking user cleanup to prevent re-entrant installs.
    this.disposed = true;
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
