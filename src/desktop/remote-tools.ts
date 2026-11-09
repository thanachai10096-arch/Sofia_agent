import type { SofiaTool, ToolContext } from "../tools/types.js";
import type { DesktopCapability, DesktopAction } from "./types.js";
import type { DesktopCommandBrokerPort } from "./remote-command-broker.js";

export function createRemoteDesktopTools(options: {
  broker: DesktopCommandBrokerPort;
  ownerKeyId: string;
  capabilities: readonly DesktopCapability[];
}): SofiaTool[] {
  const capabilities = new Set(options.capabilities);
  const require = (capability: DesktopCapability) => {
    if (!capabilities.has(capability)) throw new Error("Remote desktop capability is not granted: " + capability);
  };
  const dispatch = (action: DesktopAction, context: ToolContext) => {
    context.signal?.throwIfAborted();
    return options.broker.dispatch(options.ownerKeyId, action, { signal: context.signal });
  };
  const string = (description: string) => ({ type: "string", description });

  const tools: SofiaTool[] = [];
  if (capabilities.has("screen:capture")) {
    tools.push({
      name: "desktop.remote.screen.capture",
      description: "Capture the paired local screen after explicit approval on the computer. Screen contents may contain private information.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(input, context: ToolContext) {
        require("screen:capture");
        return dispatch({ kind: "screen.capture" }, context);
      },
    });
  }
  if (capabilities.has("app:launch")) {
    tools.push({
      name: "desktop.remote.app.launch",
      description: "Launch an application on the owner's paired local computer. The local companion will ask the operator for approval.",
      inputSchema: {
        type: "object",
        properties: {
          applicationId: string("Exact application identifier allowlisted by the local operator"),
          args: { type: "array", items: string("Application argument"), maxItems: 32 },
        },
        required: ["applicationId"],
        additionalProperties: false,
      },
      async execute(input, context: ToolContext) {
        require("app:launch");
        if (typeof input.applicationId !== "string" || !input.applicationId.trim() || input.applicationId.length > 128) {
          throw new Error("Invalid application identifier.");
        }
        const args = input.args === undefined ? [] : input.args;
        if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== "string" || arg.length > 1000 || arg.includes("\0"))) {
          throw new Error("Invalid application arguments.");
        }
        return dispatch({ kind: "app.launch", applicationId: input.applicationId, args: args as string[] }, context);
      },
    });
  }
  if (capabilities.has("input:control")) {
    tools.push(
      {
        name: "desktop.remote.input.click",
        description: "Click a coordinate on the owner's paired local screen after local operator approval.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "integer", minimum: 0, maximum: 16383 },
            y: { type: "integer", minimum: 0, maximum: 16383 },
            button: { type: "string", enum: ["left", "right", "middle"] },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
        async execute(input, context: ToolContext) {
          require("input:control");
          const button = input.button === undefined ? "left" : input.button;
          if (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y) ||
              (input.x as number) < 0 || (input.y as number) < 0 ||
              (input.x as number) > 16383 || (input.y as number) > 16383 ||
              !["left", "right", "middle"].includes(button as string)) {
            throw new Error("Invalid desktop click coordinates or button.");
          }
          return dispatch({ kind: "input.click", x: input.x as number, y: input.y as number, button: button as "left" | "right" | "middle" }, context);
        },
      },
      {
        name: "desktop.remote.input.type_text",
        description: "Type text on the owner's paired local computer after local operator approval.",
        inputSchema: { type: "object", properties: { text: string("Text to type; max 2000 characters") }, required: ["text"], additionalProperties: false },
        async execute(input, context: ToolContext) {
          require("input:control");
          if (typeof input.text !== "string" || input.text.length > 2000 || input.text.includes("\0")) {
            throw new Error("Text must be a string of at most 2000 characters.");
          }
          return dispatch({ kind: "input.type", text: input.text }, context);
        },
      },
      {
        name: "desktop.remote.input.press_key",
        description: "Press a supported key on the owner's paired local computer after local operator approval.",
        inputSchema: { type: "object", properties: { key: string("Supported key name") }, required: ["key"], additionalProperties: false },
        async execute(input, context) {
          require("input:control");
          if (typeof input.key !== "string" || input.key.length > 32) throw new Error("Invalid key name.");
          return dispatch({ kind: "input.key", key: input.key }, context);
        },
      },
    );
  }
  return tools;
}
