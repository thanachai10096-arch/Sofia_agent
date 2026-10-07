import type { SofiaTool } from "./types.js";

const stringInput = (description: string) => ({ type: "string", description });

export function createBuiltinTools(): SofiaTool[] {
  return [
    {
      name: "workspace.read_file",
      description: "Read a UTF-8 text file inside the current workspace.",
      inputSchema: { type: "object", properties: { path: stringInput("Workspace-relative file path") }, required: ["path"], additionalProperties: false },
      async execute(input, { runtime }) { return { path: String(input.path), content: await runtime.readFile(String(input.path)) }; },
    },
    {
      name: "workspace.write_file",
      description: "Create or replace a UTF-8 text file inside the current workspace.",
      inputSchema: { type: "object", properties: { path: stringInput("Workspace-relative file path"), content: stringInput("Complete file contents") }, required: ["path", "content"], additionalProperties: false },
      async execute(input, { runtime }) {
        const path = String(input.path); await runtime.writeFile(path, String(input.content)); return { ok: true, path };
      },
    },
    {
      name: "workspace.list_files",
      description: "List entries in a workspace directory.",
      inputSchema: { type: "object", properties: { path: stringInput("Workspace-relative directory path") }, additionalProperties: false },
      async execute(input, { runtime }) { return { path: String(input.path ?? "."), entries: await runtime.listFiles(String(input.path ?? ".")) }; },
    },
    {
      name: "git.run",
      description: "Run a git command in the workspace. Use for status, diff, log and other repository operations.",
      inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" }, description: "Git arguments, without the git executable" } }, required: ["args"], additionalProperties: false },
      async execute(input, { runtime }) {
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        const result = await runtime.git(args); return result;
      },
    },
    {
      name: "terminal.run",
      description: "Run an executable with arguments in the workspace. Only available when shell execution is explicitly enabled.",
      inputSchema: { type: "object", properties: { command: stringInput("Executable name"), args: { type: "array", items: { type: "string" } } }, required: ["command"], additionalProperties: false },
      async execute(input, { runtime }) {
        const command = String(input.command); const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return runtime.run(command, args);
      },
    },
  ];
}
