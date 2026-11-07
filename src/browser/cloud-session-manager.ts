import { randomUUID } from "node:crypto";
import type { BrowserPage, BrowserRuntime, BrowserSession } from "./runtime.js";

interface CloudSession {
  id: string;
  ownerId: string;
  session: BrowserSession;
  page: BrowserPage;
  createdAt: number;
  lastUsedAt: number;
}

export interface CloudBrowserManagerConfig {
  runtime?: BrowserRuntime;
  now?: () => number;
  idleTimeoutMs?: number;
  maxSessionsPerOwner?: number;
  maxScreenshotBytes?: number;
}

/**
 * Owner-isolated, ephemeral headless browser sessions for users who only have
 * a phone. The mobile client streams screenshots and sends explicit input
 * actions; browser contexts are never shared between owners.
 */
export class CloudBrowserSessionManager {
  private readonly sessions = new Map<string, CloudSession>();
  private readonly pendingByOwner = new Map<string, number>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly maxSessionsPerOwner: number;
  private readonly maxScreenshotBytes: number;

  constructor(private readonly runtime: BrowserRuntime, config: Omit<CloudBrowserManagerConfig, "runtime"> = {}) {
    this.now = config.now ?? Date.now;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 15 *  60_000;
    this.maxSessionsPerOwner = config.maxSessionsPerOwner ?? 2;
    this.maxScreenshotBytes = config.maxScreenshotBytes ?? 3 * 1024 * 1024;
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 60_000 ||
        !Number.isSafeInteger(this.maxSessionsPerOwner) || this.maxSessionsPerOwner < 1 ||
        !Number.isSafeInteger(this.maxScreenshotBytes) || this.maxScreenshotBytes < 64 * 1024) {
      throw new Error("Invalid cloud browser manager limits.");
    }
    this.cleanupTimer = setInterval(() => { void this.expireIdle(); }, Math.min(this.idleTimeoutMs, 60_000));
    this.cleanupTimer.unref?.();
  }

  private async expireIdle(): Promise<void> {
    const cutoff = this.now() - this.idleTimeoutMs;
    const expired = [...this.sessions.values()].filter((item) => item.lastUsedAt <= cutoff);
    for (const item of expired) {
      this.sessions.delete(item.id);
      await item.session.close().catch(() => undefined);
    }
  }

  private owned(ownerId: string, sessionId: string): CloudSession {
    if (!ownerId.trim() || !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Cloud browser session not found.");
    const item = this.sessions.get(sessionId);
    if (!item || item.ownerId !== ownerId) throw new Error("Cloud browser session not found.");
    item.lastUsedAt = this.now();
    return item;
  }

  async create(ownerId: string): Promise<{ id: string; createdAt: number; expiresInMs: number; url: string }> {
    if (!ownerId.trim() || ownerId.length > 512) throw new Error("A valid browser session owner is required.");
    await this.expireIdle();
    const count = [...this.sessions.values()].filter((item) => item.ownerId === ownerId).length;
    const pending = this.pendingByOwner.get(ownerId) ?? 0;
    if (count + pending >= this.maxSessionsPerOwner) throw new Error("Cloud browser session limit reached.");
    this.pendingByOwner.set(ownerId, pending + 1);
    let session: BrowserSession | undefined;
    try {
      session = await this.runtime.launch({ headless: true });
      const page = await session.newPage();
      const now = this.now();
      const id = randomUUID();
      this.sessions.set(id, { id, ownerId, session, page, createdAt: now, lastUsedAt: now });
      return { id, createdAt: now, expiresInMs: this.idleTimeoutMs, url: await page.url() };
    } catch (error) {
      await session?.close().catch(() => undefined);
      throw error;
    } finally {
      const remaining = (this.pendingByOwner.get(ownerId) ?? 1) - 1;
      if (remaining <= 0) this.pendingByOwner.delete(ownerId);
      else this.pendingByOwner.set(ownerId, remaining);
    }
  }

  async status(ownerId: string, sessionId: string): Promise<{ id: string; url: string; title: string; createdAt: number; expiresInMs: number }> {
    await this.expireIdle();
    const item = this.owned(ownerId, sessionId);
    return {
      id: item.id, url: await item.page.url(), title: await item.page.title(),
      createdAt: item.createdAt, expiresInMs: Math.max(0, this.idleTimeoutMs - (this.now() - item.lastUsedAt)),
    };
  }

  async navigate(ownerId: string, sessionId: string, url: string): Promise<{ url: string; title: string }> {
    if (typeof url !== "string" || url.length > 4096) throw new Error("Invalid browser URL.");
    await this.expireIdle();
    const item = this.owned(ownerId, sessionId);
    await item.page.goto(url);
    return { url: await item.page.url(), title: await item.page.title() };
  }

  async observe(ownerId: string, sessionId: string): Promise<{ url: string; title: string; content: string }> {
    await this.expireIdle();
    const item = this.owned(ownerId, sessionId);
    return { url: await item.page.url(), title: await item.page.title(), content: (await item.page.content()).slice(0, 50_000) };
  }

  async screenshot(ownerId: string, sessionId: string): Promise<{ imageBase64: string; mimeType: "image/png"; width: number; height: number }> {
    await this.expireIdle();
    const item = this.owned(ownerId, sessionId);
    const imageBase64 = await item.page.screenshot();
    if (Buffer.byteLength(imageBase64, "base64") > this.maxScreenshotBytes) throw new Error("Cloud browser screenshot is too large.");
    const viewport = await item.page.viewportSize?.() ?? { width: 1280, height: 720 };
    return { imageBase64, mimeType: "image/png", width: viewport.width, height: viewport.height };
  }

  async act(ownerId: string, sessionId: string, action: Record<string, unknown>): Promise<{ ok: true; url: string }> {
    await this.expireIdle();
    const item = this.owned(ownerId, sessionId);
    const kind = action.kind;
    if (kind === "clickAt" && Number.isFinite(action.x) && Number.isFinite(action.y) &&
      Math.abs(Number(action.x)) <= 10000 && Math.abs(Number(action.y)) <= 10000 && item.page.clickAt) {
      await item.page.clickAt(Number(action.x), Number(action.y));
    } else if (kind === "typeFocused" && typeof action.text === "string" && action.text.length <= 4000 && item.page.typeFocused) {
      await item.page.typeFocused(action.text);
    } else if (kind === "pressFocused" && typeof action.key === "string" && action.key.length <= 32 &&
      ["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(action.key) && item.page.pressFocused) {
      await item.page.pressFocused(action.key);
    } else if (kind === "click" && typeof action.selector === "string" && action.selector.length <= 1000) {
      await item.page.click(action.selector);
    } else if (kind === "type" && typeof action.selector === "string" && action.selector.length <= 1000 &&
      typeof action.text === "string" && action.text.length <= 4000) {
      await item.page.type(action.selector, action.text);
    } else if (kind === "press" && typeof action.key === "string" && action.key.length <= 64) {
      await item.page.press(typeof action.selector === "string" ? action.selector : "body", action.key);
    } else if (kind === "scroll" && Number.isFinite(action.x) && Number.isFinite(action.y) &&
      Math.abs(Number(action.x)) <= 5000 && Math.abs(Number(action.y)) <= 5000) {
      await item.page.scroll(Number(action.x), Number(action.y));
    } else if (kind === "back") {
      await item.page.back();
    } else if (kind === "forward") {
      await item.page.forward();
    } else if (kind === "reload") {
      await item.page.reload();
    } else {
      throw new Error("Unsupported cloud browser action.");
    }
    return { ok: true, url: await item.page.url() };
  }

  async close(ownerId: string, sessionId: string): Promise<boolean> {
    const item = this.owned(ownerId, sessionId);
    this.sessions.delete(sessionId);
    await item.session.close();
    return true;
  }

  async closeAll(): Promise<void> {
    clearInterval(this.cleanupTimer);
    const current = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(current.map((item) => item.session.close()));
  }
}
