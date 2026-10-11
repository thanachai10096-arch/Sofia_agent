import type { SofiaTool, ToolContext } from "../tools/types.js";
import type { DesktopPrincipal } from "./types.js";
import { DesktopRuntime } from "./runtime.js";

/**
 * Exposes permission-gated local desktop capabilities as opt-in Sofia tools.
 * Callers must deliberately add these tools to a registry; no desktop access
 * is enabled by importing Sofia or creating the default tool registry.
 *
 * The principal is intentionally supplied by the local host, not by model input.
 * For multi-user servers, resolve a distinct principal per authenticated user
 * before constructing that user's registry.
 */
export function createDesktopTools(options: {
  runtime: DesktopRuntime;
  principal: DesktopPrincipal;
}): SofiaTool[] {
  const { runtime, principal } = options;
  const string = (description: string) => ({ type: "string", description });
  const invoke = (context: ToolContext, fn: () => Promise<unknown>) => {
    context.signal?.throwIfAborted();
    return fn();
  };

  return [
    {
      name: "desktop.system.discover",
      description: "Discover the local runtime platform and explicitly granted capabilities.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, context) {
        return invoke(context, () => runtime.discover(principal));
      },
    },
    {
      name: "desktop.workspace.list_files",
      description: "List entries within the explicitly configured desktop workspace.",
      inputSchema: {
        type: "object",
        properties: { path: string("Workspace-relative directory path; defaults to root") },
        additionalProperties: false,
      },
      async execute(input, context) {
        return invoke(context, async () => ({
          entries: await runtime.listFiles(principal, typeof input.path === "string" ? input.path : "."),
        }));
      },
    },
    {
      name: "desktop.workspace.read_file",
      description: "Read a UTF-8 text file within the explicitly configured desktop workspace.",
      inputSchema: {
        type: "object",
        properties: { path: string("Workspace-relative file path") },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input, context) {
        if (typeof input.path !== "string") throw new Error("A relative file path is required.");
        return invoke(context, async () => ({ path: input.path, content: await runtime.readTextFile(principal, input.path as string) }));
      },
    },
    {
      name: "desktop.workspace.write_file",
      description: "Create or replace a UTF-8 text file within the explicitly configured desktop workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: string("Workspace-relative file path"),
          content: string("Complete UTF-8 file contents"),
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute(input, context) {
        if (typeof input.path !== "string" || typeof input.content !== "string") {
          throw new Error("A relative file path and string content are required.");
        }
        return invoke(context, () => runtime.writeTextFile(principal, input.path as string, input.content as string));
      },
    },
    {
      name: "desktop.process.run",
      description: "Run an explicitly allowlisted executable without a shell, inside the configured workspace.",
      inputSchema: {
        type: "object",
        properties: {
          command: string("Executable name; must be allowlisted by the local host"),
          args: { type: "array", items: string("A single process argument; never interpreted by a shell") },
          cwd: string("Optional workspace-relative working directory"),
          timeoutMs: { type: "integer", minimum: 1000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async execute(input, context) {
        if (typeof input.command !== "string") throw new Error("An executable name is required.");
        const args = Array.isArray(input.args) && input.args.every((item) => typeof item === "string")
          ? input.args as string[]
          : [];
        if (Array.isArray(input.args) && args.length !== input.args.length) throw new Error("All process arguments must be strings.");
        return invoke(context, () => runtime.runCommand(principal, input.command as string, args, {
          ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        }));
      },
    },
  ];
}
