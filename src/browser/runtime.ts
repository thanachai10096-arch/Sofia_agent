export interface BrowserPage {
  id: string;
  url(): Promise<string>;
  title(): Promise<string>;
  content(): Promise<string>;
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  scroll(x: number, y: number): Promise<void>;
  wait(ms: number): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  screenshot(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserSession {
  id: string;
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserRuntime {
  launch(): Promise<BrowserSession>;
}

export class PlaywrightBrowserRuntime implements BrowserRuntime {
  constructor(private readonly headless = true) {}

  async launch(): Promise<BrowserSession> {
    const load = new Function("return import('playwright')") as () => Promise<any>;
    const playwright = await load();
    const browser = await playwright.chromium.launch({ headless: this.headless });
    const context = await browser.newContext();
    const pages = new Map<string, any>();

    return {
      id: crypto.randomUUID(),
      newPage: async () => {
        const page = await context.newPage();
        const id = crypto.randomUUID();
        pages.set(id, page);
        return {
          id,
          url: () => page.url(),
          title: () => page.title(),
          content: () => page.content(),
          goto: async (url: string) => { await page.goto(url, { waitUntil: "domcontentloaded" }); },
          click: async (selector: string) => { await page.locator(selector).click(); },
          type: async (selector: string, text: string) => { await page.locator(selector).fill(text); },
          select: async (selector: string, value: string) => { await page.locator(selector).selectOption(value); },
          scroll: async (x: number, y: number) => { await page.mouse.wheel(x, y); },
          wait: async (ms: number) => { await page.waitForTimeout(Math.max(0, Math.min(ms, 30_000))); },
          press: async (selector: string, key: string) => { await page.locator(selector).press(key); },
          back: async () => { await page.goBack({ waitUntil: "domcontentloaded" }); },
          forward: async () => { await page.goForward({ waitUntil: "domcontentloaded" }); },
          reload: async () => { await page.reload({ waitUntil: "domcontentloaded" }); },
          screenshot: async () => (await page.screenshot({ type: "png" })).toString("base64"),
          close: async () => { pages.delete(id); await page.close(); },
        } satisfies BrowserPage;
      },
      close: async () => { pages.clear(); await context.close(); await browser.close(); },
    };
  }
}
