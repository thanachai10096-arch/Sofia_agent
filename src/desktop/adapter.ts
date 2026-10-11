import type { SofiaTool, ToolContext } from "../tools/types.js";
import type { DesktopAction, DesktopAdapterConfig, DesktopPrincipal } from "./types.js";
import { requireCapability } from "./policy.js";

const MAX_SCREEN_BYTES = 5 * 1024 * 1024;
const KEY_PATTERN = /^(?:[A-Za-z0-9]|Enter|Escape|Tab|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Space|F(?:[1-9]|1[0-2])|Ctrl\+[A-Za-z0-9]|Alt\+[A-Za-z0-9]|Shift\+[A-Za-z0-9])$/;

function approved(config: DesktopAdapterConfig, action: DesktopAction): Promise<void> {
  return config.requestApproval(action).then((allow) => {
    if (!allow) throw new Error("Desktop action was denied by the user.");
  });
}

/**
 * Native desktop tools. The actual OS driver is injected by the local host;
 * importing this module never starts a background service or grants access.
 */
export function createDesktopAdapterTools(options: {
  config: DesktopAdapterConfig;
  principal: DesktopPrincipal;
}): SofiaTool[] {
  const { config, principal } = options;
  const maxTextLength = Math.min(Math.max(1, config.maxTextLength ?? 2000), 2000);
  const allowedApplications = new Set(config.allowedApplications ?? []);
  const allowedApplicationArgs = config.allowedApplicationArgs ?? {};
  const string = (description: string) => ({ type: "string", description });

  return [
    {
      name: "desktop.screen.capture",
      description: "Capture the screen through the locally installed desktop host; requires explicit screen permission.",
      inputSchema: { type: "object", properties: { displayId: string("Optional display identifier") }, additionalProperties: false },
      async execute(input, context: ToolContext) {
        context.signal?.throwIfAborted();
        requireCapability(principal, "screen:capture");
        const capture = await config.driver.captureScreen(typeof input.displayId === "string" ? { displayId: input.displayId } : undefined);
        context.signal?.throwIfAborted();
        if (capture.mimeType !== "image/png" && capture.mimeType !== "image/jpeg") throw new Error("Desktop driver returned an unsupported image MIME type.");
        if (!(capture.data instanceof Uint8Array)) throw new Error("Desktop driver returned invalid image data.");
        if (capture.data.byteLength > MAX_SCREEN_BYTES) throw new Error("Screen capture exceeds the 5 MiB limit.");
        if (!Number.isInteger(capture.width) || !Number.isInteger(capture.height) || capture.width < 1 || capture.height < 1 || capture.width > 16384 || capture.height > 16384) {
          throw new Error("Desktop driver returned invalid screen dimensions.");
        }
        return { mimeType: capture.mimeType, dataBase64: Buffer.from(capture.data).toString("base64"), width: capture.width, height: capture.height };
      },
    },
    {
      name: "desktop.app.launch",
      description: "Launch an operator-allowlisted application after explicit user approval.",
      inputSchema: {
        type: "object",
        properties: { applicationId: string("Exact local application identifier"), args: { type: "array", items: string("Application argument") } },
        required: ["applicationId"],
        additionalProperties: false,
      },
      async execute(input, context: ToolContext) {
        context.signal?.throwIfAborted();
        requireCapability(principal, "app:launch");
        if (typeof input.applicationId !== "string" || !allowedApplications.has(input.applicationId)) throw new Error("Application is not allowlisted by the local operator.");
        const args = Array.isArray(input.args) && input.args.every((item) => typeof item === "string" && !item.includes("\0")) ? input.args as string[] : [];
        if (Array.isArray(input.args) && args.length !== input.args.length) throw new Error("Application arguments must be valid strings.");
        const permittedArgs = new Set(allowedApplicationArgs[input.applicationId] ?? []);
        if (args.some((arg) => !permittedArgs.has(arg))) throw new Error("Application arguments are not allowlisted for this application.");
        await approved(config, { kind: "app.launch", applicationId: input.applicationId, args });
        context.signal?.throwIfAborted();
        return config.driver.launchApplication(input.applicationId, args);
      },
    },
    {
      name: "desktop.input.click",
      description: "Click a screen coordinate after explicit user approval.",
      inputSchema: {
        type: "object",
        properties: { x: { type: "integer", minimum: 0, maximum: 16383 }, y: { type: "integer", minimum: 0, maximum: 16383 }, button: { type: "string", enum: ["left", "right", "middle"] } },
        required: ["x", "y"],
        additionalProperties: false,
      },
      async execute(input, context: ToolContext) {
        context.signal?.throwIfAborted();
        requireCapability(principal, "input:control");
        if (!Number.isInteger(input.x) || !Number.isInteger(input.y) || (input.x as number) < 0 || (input.y as number) < 0 || (input.x as number) > 16383 || (input.y as number) > 16383) throw new Error("Click coordinates must be integers between 0 and 16383.");
        const button = input.button === undefined ? "left" : input.button;
        if (button !== "left" && button !== "right" && button !== "middle") throw new Error("Unsupported mouse button.");
        await approved(config, { kind: "input.click", x: input.x as number, y: input.y as number, button });
        context.signal?.throwIfAborted();
        await config.driver.click({ x: input.x as number, y: input.y as number, button });
        return { ok: true };
      },
    },
    {
      name: "desktop.input.type_text",
      description: "Type text after explicit user approval; limited to 2000 characters per action.",
      inputSchema: { type: "object", properties: { text: string("Text to type; max 2000 characters") }, required: ["text"], additionalProperties: false },
      async execute(input, context: ToolContext) {
        context.signal?.throwIfAborted();
        requireCapability(principal, "input:control");
        if (typeof input.text !== "string" || input.text.length > maxTextLength || input.text.includes("\0")) throw new Error(`Text must be a string of at most ${maxTextLength} characters.`);
        await approved(config, { kind: "input.type", characterCount: input.text.length });
        context.signal?.throwIfAborted();
        await config.driver.typeText(input.text);
        return { ok: true, characters: input.text.length };
      },
    },
    {
      name: "desktop.input.press_key",
      description: "Press a restricted key or modifier combination after explicit user approval.",
      inputSchema: { type: "object", properties: { key: string("Allowed key name, such as Enter, Escape, Tab, ArrowDown, or Ctrl+A") }, required: ["key"], additionalProperties: false },
      async execute(input, context: ToolContext) {
        context.signal?.throwIfAborted();
        requireCapability(principal, "input:control");
        if (typeof input.key !== "string" || !KEY_PATTERN.test(input.key)) throw new Error("Key is not in the desktop adapter allowlist.");
        await approved(config, { kind: "input.key", key: input.key });
        context.signal?.throwIfAborted();
        await config.driver.pressKey(input.key);
        return { ok: true, key: input.key };
      },
    },
  ];
}
