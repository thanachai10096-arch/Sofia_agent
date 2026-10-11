import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

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

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  const c = octets[2] ?? -1;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") ||
      value.startsWith("feb") || value.startsWith("ff") || value.startsWith("2001:db8:") ||
      value.startsWith("2002:") || value.startsWith("3fff:")) return true;
  // IANA special-purpose IPv6 block 2001:0000::/23 includes Teredo, benchmarking,
  // and other non-public ranges. A compressed zero second hextet is also in-range.
  if (value.startsWith("2001:")) {
    const second = value.slice(5).split(":")[0] ?? "";
    if (second === "" || (/^[0-9a-f]{1,4}$/i.test(second) && Number.parseInt(second, 16) <= 0x01ff)) return true;
  }
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice(7);
    if (mapped.includes(".")) return isPrivateIpv4(mapped);
    return true;
  }
  // Only global-unicast IPv6 (2000::/3) is accepted.
  return !/^[23][0-9a-f]{0,3}:/i.test(value);
}

/**
 * Prevent direct navigation to local/private targets and non-web URL schemes.
 * This is a defense-in-depth URL check, not a replacement for network egress
 * controls when running agents against untrusted websites.
 */
export function assertSafeBrowserUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("Browser navigation requires a valid public HTTP(S) URL."); }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser navigation only supports HTTP and HTTPS URLs.");
  }
  if (url.username || url.password) {
    throw new Error("Browser navigation does not allow embedded URL credentials.");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") ||
      host.endsWith(".example") || host.endsWith(".invalid") ||
      host === "metadata.google.internal" || host === "metadata") {
    throw new Error("Browser navigation to local or internal hosts is blocked.");
  }

  const ipVersion = isIP(host.replace(/^\[|\]$/g, ""));
  if ((ipVersion === 4 && isPrivateIpv4(host)) || (ipVersion === 6 && isPrivateIpv6(host))) {
    throw new Error("Browser navigation to private or non-public IP addresses is blocked.");
  }
  return url;
}

async function assertPublicResolvedHost(host: string): Promise<void> {
  const normalized = host.replace(/^\\[|\\]$/g, "");
  if (isIP(normalized)) return; // Literal IPs are checked by assertSafeBrowserUrl.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new Error("Browser navigation host could not be resolved safely.");
  }
  if (addresses.length === 0) throw new Error("Browser navigation host has no public address.");
  for (const item of addresses) {
    const address = item.address.toLowerCase();
    const family = isIP(address);
    if ((family === 4 && isPrivateIpv4(address)) || (family === 6 && isPrivateIpv6(address)) || family === 0) {
      throw new Error("Browser navigation to a host resolving to private or non-public IP addresses is blocked.");
    }
  }
}

export class PlaywrightBrowserRuntime implements BrowserRuntime {
  constructor(private readonly headless = true) {}

  async launch(): Promise<BrowserSession> {
    const load = new Function("return import('playwright')") as () => Promise<any>;
    const playwright = await load();
    const browser = await playwright.chromium.launch({ headless: this.headless });
    const context = await browser.newContext();
    // Apply the same URL policy to every request, including redirects and subresources.
    await context.route("**/*", async (route: any) => {
      try {
        const requestUrl = assertSafeBrowserUrl(route.request().url());
        await assertPublicResolvedHost(requestUrl.hostname);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });

    return {
      id: crypto.randomUUID(),
      newPage: async () => {
        const page = await context.newPage();
        const id = crypto.randomUUID();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(30_000);
        return {
          id,
          url: () => page.url(),
          title: () => page.title(),
          content: () => page.content(),
          goto: async (url: string) => {
            const target = assertSafeBrowserUrl(url);
            await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
          },
          click: async (selector: string) => { await page.locator(selector).click(); },
          type: async (selector: string, text: string) => { await page.locator(selector).fill(text); },
          select: async (selector: string, value: string) => { await page.locator(selector).selectOption(value); },
          scroll: async (x: number, y: number) => { await page.mouse.wheel(x, y); },
          wait: async (ms: number) => { await page.waitForTimeout(Math.max(0, Math.min(ms, 30_000))); },
          press: async (selector: string, key: string) => { await page.locator(selector).press(key); },
          back: async () => { await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }); },
          forward: async () => { await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }); },
          reload: async () => { await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }); },
          screenshot: async () => (await page.screenshot({ type: "png" })).toString("base64"),
          close: async () => { await page.close(); },
        } satisfies BrowserPage;
      },
      close: async () => { await context.close(); await browser.close(); },
    };
  }
}
