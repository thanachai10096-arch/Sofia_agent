import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = octets[0]!;
  const b = octets[1]!;
  const c = octets[2]!;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 255 && b === 255);
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? "";
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") ||
      value.startsWith("feb") || value.startsWith("ff") || value.startsWith("2001:db8:")) return true;
  const mapped = value.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  // Permit only global-unicast 2000::/3 IPv6 destinations.
  return !/^[23][0-9a-f]{0,3}:/i.test(value);
}

function isUnsafeAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

/**
 * Reject local/private targets before navigation and on every intercepted request.
 * This is an application-level SSRF guard; production hosts should additionally
 * enforce outbound network policy because DNS validation alone cannot prevent
 * all DNS-rebinding and network-level routing attacks.
 */
export async function assertSafeBrowserUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Blocked invalid browser URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Blocked unsupported browser URL protocol.");
  }
  if (url.username || url.password) throw new Error("Blocked browser URL containing credentials.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".test")) {
    throw new Error("Blocked local or reserved browser hostname.");
  }
  if (isIP(hostname)) {
    if (isUnsafeAddress(hostname)) throw new Error("Blocked private or non-public browser IP address.");
    return;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Blocked browser hostname that could not be resolved safely.");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isUnsafeAddress(address))) {
    throw new Error("Blocked browser hostname resolving to a private or non-public IP address.");
  }
}

export class PlaywrightBrowserRuntime implements BrowserRuntime {
  constructor(private readonly headless = true) {}

  async launch(): Promise<BrowserSession> {
    const load = new Function("return import('playwright')") as () => Promise<any>;
    const playwright = await load();
    const browser = await playwright.chromium.launch({ headless: this.headless });
    const context = await browser.newContext();
    // Guard every request, not just the first navigation, so redirects and
    // subresources cannot silently target local/private network addresses.
    await context.route("**/*", async (route: any) => {
      try {
        await assertSafeBrowserUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
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
          goto: async (url: string) => {
            await assertSafeBrowserUrl(url);
            await page.goto(url, { waitUntil: "domcontentloaded" });
          },
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
