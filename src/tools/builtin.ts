import type { SofiaTool } from "./types.js";
import { applyEditPatch, createEditPatch } from "../brain/edit-engine.js";

const str = (description: string) => ({ type: "string", description });

const editOperationSchema = {
  type: "object",
  properties: {
    path: str("Workspace-relative file path"),
    expectedContent: str("Exact file content observed when the edit was planned"),
    expectedHash: str("SHA-256 hash of the file content observed when the edit was planned"),
    content: str("Complete replacement file contents"),
  },
  required: ["path", "content"],
  additionalProperties: false,
};

export function createBuiltinTools(): SofiaTool[] {
  return [
    {
      name: "workspace.read_file",
      description: "Read a UTF-8 text file inside the current workspace.",
      inputSchema: {
        type: "object",
        properties: { path: str("Workspace-relative file path") },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const path = String(input.path);
        return { path, content: await runtime.readFile(path) };
      },
    },
    {
      name: "workspace.apply_patch",
      description:
        "Apply one or more conflict-checked file edits. Every edit must include the expected file content or its SHA-256 hash, so stale edits are rejected instead of overwriting newer changes.",
      inputSchema: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            items: editOperationSchema,
            minItems: 1,
          },
        },
        required: ["operations"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        if (!Array.isArray(input.operations)) {
          throw new Error("Patch operations must be an array");
        }

        const operations = input.operations.map((value) => {
          if (!value || typeof value !== "object") {
            throw new Error("Invalid patch operation");
          }

          const item = value as Record<string, unknown>;
          if (typeof item.path !== "string" || typeof item.content !== "string") {
            throw new Error("Patch operation requires path and content");
          }

          return {
            path: item.path,
            content: item.content,
            ...(typeof item.expectedContent === "string"
              ? { expectedContent: item.expectedContent }
              : {}),
            ...(typeof item.expectedHash === "string"
              ? { expectedHash: item.expectedHash }
              : {}),
          };
        });

        const patch = createEditPatch(operations);
        const results = await applyEditPatch(runtime, patch);

        return {
          patchId: patch.id,
          results,
          changedFiles: results.filter((result) => result.changed).map((result) => result.path),
        };
      },
    },
    {
      name: "workspace.write_file",
      description: "Create or replace a UTF-8 text file inside the current workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: str("Workspace-relative file path"),
          content: str("Complete file contents"),
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const path = String(input.path);
        await runtime.writeFile(path, String(input.content));
        return { ok: true, path };
      },
    },
    {
      name: "workspace.search",
      description: "Search workspace files for a text query.",
      inputSchema: {
        type: "object",
        properties: { query: str("Text to search for"), path: str("Optional workspace-relative path") },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        return runtime.search(String(input.query), typeof input.path === "string" ? input.path : undefined);
      },
    },
    {
      name: "workspace.list_files",
      description: "List entries in a workspace directory.",
      inputSchema: {
        type: "object",
        properties: { path: str("Workspace-relative directory path") },
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const path = String(input.path ?? ".");
        return { path, entries: await runtime.listFiles(path) };
      },
    },
    {
      name: "project.verify",
      description: "Run a bounded project verification command such as typecheck, test, or build.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["typecheck", "test", "build"] },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const kind = String(input.kind);
        const commands: Record<string, [string, string[]]> = {
          typecheck: ["npm", ["run", "typecheck"]],
          test: ["npm", ["test"]],
          build: ["npm", ["run", "build"]],
        };
        const command = commands[kind];
        if (!command) throw new Error("Unsupported verification kind: " + kind);
        const [executable, args] = command;
        const result = await runtime.run(executable, args);
        return { kind, command: executable, args, ...result, passed: result.code === 0 };
      },
    },
    {
      name: "git.diff",
      description: "Inspect the current git diff without changing the workspace.",
      inputSchema: {
        type: "object",
        properties: { args: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return runtime.git(["diff", ...args]);
      },
    },
    {
      name: "git.run",
      description: "Run a git command in the workspace.",
      inputSchema: {
        type: "object",
        properties: { args: { type: "array", items: { type: "string" } } },
        required: ["args"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return runtime.git(args);
      },
    },
    {
      name: "terminal.run",
      description:
        "Run an executable with arguments in the workspace. Only available when shell execution is explicitly enabled.",
      inputSchema: {
        type: "object",
        properties: {
          command: str("Executable name"),
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const command = String(input.command);
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return runtime.run(command, args);
      },
    },
  ];
}
