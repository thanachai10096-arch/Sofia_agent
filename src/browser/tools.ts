import type { SofiaTool } from "../tools/types.js";
import type { BrowserRuntime } from "./runtime.js";
import type { BrowserProfileStore } from "./profile-store.js";

export interface BrowserToolOptions { profileStore?: BrowserProfileStore; ownerId?: string; allowLogin?: boolean; }

export function createBrowserTools(runtime: BrowserRuntime, registerCleanup?: (cleanup: () => Promise<void>) => void, options: BrowserToolOptions = {}): SofiaTool[] {
  let session: Awaited<ReturnType<BrowserRuntime["launch"]>> | undefined;
  let activeProfileId: string | undefined;
  const pages = new Map<string, Awaited<ReturnType<NonNullable<typeof session>["newPage"]>>>();

  const dispose = async (): Promise<void> => {
    const closing = session;
    session = undefined;
    activeProfileId = undefined;
    pages.clear();
    if (closing) await closing.close();
  };
  registerCleanup?.(dispose);

  const page = (id: string) => {
    const value = pages.get(id);
    if (!value) throw new Error("Unknown browser page: " + id);
    return value;
  };

  const tools: SofiaTool[] = [
    {
      name: "browser.open",
      description: "Launch an isolated browser page. Optionally use this user's saved profileId.",
      inputSchema: { type: "object", properties: { profileId: { type: "string" } }, additionalProperties: false },
      async execute(input) {
        if (typeof input.profileId === "string") {
          if (!options.profileStore || !options.ownerId) throw new Error("Saved browser profiles are unavailable on this host.");
          if (session && activeProfileId !== input.profileId) await dispose();
          if (!session) {
            const profile = await options.profileStore.get(options.ownerId, input.profileId);
            session = await runtime.launch({ profileDirectory: profile.directory, headless: false });
            activeProfileId = input.profileId;
          }
        } else {
          if (session && activeProfileId) await dispose();
          session ??= await runtime.launch();
        }
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
          try {
            await value.close();
          } finally {
            // Never leave a closed or partially-closed page addressable by later actions.
            pages.delete(id);
          }
          return { ok: true, closed: "page", pageId: id };
        }
        await dispose();
        return { ok: true, closed: "session" };
      },
    },
  ];
  if (options.allowLogin && options.profileStore && options.ownerId) {
    tools.unshift({
      name: "browser.login",
      description: "Open a visible local browser with a new private profile. The user completes sign-in directly in that browser; never request passwords, OTPs, cookies, or tokens in chat.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
      async execute(input) {
        if (session) await dispose();
        const profile = await options.profileStore!.create(options.ownerId!);
        try {
          session = await runtime.launch({ profileDirectory: profile.directory, headless: false });
          activeProfileId = profile.id;
          const value = await session.newPage();
          pages.set(value.id, value);
          await value.goto(String(input.url));
          return { profileId: profile.id, pageId: value.id, url: await value.url(), loginHandoff: "Complete sign-in in the visible browser window. Do not paste credentials into Sofia chat." };
        } catch (error) {
          await dispose().catch(() => undefined);
          await options.profileStore!.revoke(options.ownerId!, profile.id).catch(() => undefined);
          throw error;
        }
      },
    });
    tools.unshift({
      name: "browser.profile.list",
      description: "List this user's saved browser profile IDs and timestamps; never return cookies or credential data.",
      inputSchema: { type: "object", additionalProperties: false },
      async execute() {
        const profiles = await options.profileStore!.list(options.ownerId!);
        return { profiles: profiles.map(({ id, createdAt, lastUsedAt }) => ({ id, createdAt, lastUsedAt })) };
      },
    });
    tools.unshift({
      name: "browser.profile.revoke",
      description: "Close the current browser session and permanently revoke one of this user's saved browser profiles.",
      inputSchema: { type: "object", properties: { profileId: { type: "string" } }, required: ["profileId"], additionalProperties: false },
      async execute(input) {
        await dispose();
        await options.profileStore!.revoke(options.ownerId!, String(input.profileId));
        return { ok: true, revoked: true };
      },
    });
  }
  return tools;
}
