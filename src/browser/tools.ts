import type { SofiaTool } from "../tools/types.js";
import type { BrowserRuntime } from "./runtime.js";

export function createBrowserTools(runtime: BrowserRuntime): SofiaTool[] {
  let session: Awaited<ReturnType<BrowserRuntime["launch"]>> | undefined;
  const pages = new Map<string, Awaited<ReturnType<NonNullable<typeof session>["newPage"]>>>();

  const page = (id: string) => {
    const value = pages.get(id);
    if (!value) throw new Error("Unknown browser page: " + id);
    return value;
  };

  return [
    {
      name: "browser.open",
      description: "Launch the browser and create a page.",
      inputSchema: { type: "object", additionalProperties: false },
      async execute() {
        session ??= await runtime.launch();
        const value = await session.newPage();
        pages.set(value.id, value);
        return { pageId: value.id, url: await value.url() };
      },
    },
    {
      name: "browser.goto",
      description: "Navigate an existing browser page.",
      inputSchema: { type: "object", properties: { pageId: { type: "string" }, url: { type: "string" } }, required: ["pageId", "url"], additionalProperties: false },
      async execute(input) { const p = page(String(input.pageId)); await p.goto(String(input.url)); return { url: await p.url(), title: await p.title() }; },
    },
    {
      name: "browser.click",
      description: "Click a page selector.",
      inputSchema: { type: "object", properties: { pageId: { type: "string" }, selector: { type: "string" } }, required: ["pageId", "selector"], additionalProperties: false },
      async execute(input) { await page(String(input.pageId)).click(String(input.selector)); return { ok: true }; },
    },
    {
      name: "browser.type",
      description: "Fill a page input.",
      inputSchema: { type: "object", properties: { pageId: { type: "string" }, selector: { type: "string" }, text: { type: "string" } }, required: ["pageId", "selector", "text"], additionalProperties: false },
      async execute(input) { await page(String(input.pageId)).type(String(input.selector), String(input.text)); return { ok: true }; },
    },
    {
      name: "browser.observe",
      description: "Read URL, title and current HTML for evidence.",
      inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"], additionalProperties: false },
      async execute(input) { const p=page(String(input.pageId)); return { url: await p.url(), title: await p.title(), content: (await p.content()).slice(0, 50_000) }; },
    },
    {
      name: "browser.action",
      description: "Perform select, scroll, wait, press, back or forward.",
      inputSchema: { type: "object", properties: { pageId:{type:"string"}, action:{type:"string",enum:["select","scroll","wait","press","back","forward","reload"]}, selector:{type:"string"}, value:{type:"string"}, x:{type:"number"}, y:{type:"number"}, ms:{type:"number"} }, required:["pageId","action"], additionalProperties:false },
      async execute(input) {
        const p=page(String(input.pageId)); const action=String(input.action);
        if(action==="select") await p.select(String(input.selector),String(input.value));
        else if(action==="scroll") await p.scroll(Number(input.x??0),Number(input.y??500));
        else if(action==="wait") await p.wait(Number(input.ms??500));
        else if(action==="press") await p.press(String(input.selector??"body"),String(input.value));
        else if(action==="back") await p.back();
        else if(action==="forward") await p.forward();
        else await p.reload();
        return { url: await p.url() };
      },
    },
    {
      name: "browser.screenshot",
      description: "Capture the current browser page.",
      inputSchema: { type:"object", properties:{pageId:{type:"string"}}, required:["pageId"], additionalProperties:false },
      async execute(input){ return { imageBase64: await page(String(input.pageId)).screenshot() }; },
    },
    {
      name: "browser.close",
      description: "Close a browser page or the entire session.",
      inputSchema: { type:"object", properties:{pageId:{type:"string"}}, additionalProperties:false },
      async execute(input){
        if (typeof input.pageId === "string") {
          const id = input.pageId;
          const value = page(id);
          await value.close();
          pages.delete(id);
          return { ok: true, closed: "page", pageId: id };
        }
        if (session) {
          await session.close();
          session = undefined;
          pages.clear();
        }
        return { ok: true, closed: "session" };
      },
    },
  ];
}
