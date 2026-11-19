import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserProfileStore } from "./profile-store.js";
import { BrowserProfileSessionManager } from "./profile-sessions.js";
import { createBrowserTools } from "./tools.js";
import type { BrowserPage, BrowserRuntime, BrowserSession } from "./runtime.js";

function setup() {
  let launchCount = 0;
  let sessionCloseCount = 0;
  let pageCloseCount = 0;
  let pageCounter = 0;
  const makePage = (id: string) => ({
    id,
    url: async () => "about:blank",
    title: async () => "",
    content: async () => "",
    goto: async () => {},
    click: async () => {},
    type: async () => {},
    select: async () => {},
    scroll: async () => {},
    wait: async () => {},
    press: async () => {},
    back: async () => {},
    forward: async () => {},
    reload: async () => {},
    screenshot: async () => "",
    close: async () => { pageCloseCount++; },
  } satisfies BrowserPage);
  const runtime = {
    launch: async () => {
      launchCount++;
      return {
        id: "session-1",
        newPage: async () => makePage("page-" + (++pageCounter)),
        close: async () => { sessionCloseCount++; },
      } satisfies BrowserSession;
    },
  } satisfies BrowserRuntime;
  const tools = createBrowserTools(runtime);
  const tool = (name: string) => {
    const found = tools.find((item) => item.name === name);
    assert.ok(found, "missing browser tool " + name);
    return found;
  };
  return {
    tool,
    counts: () => ({ launchCount, sessionCloseCount, pageCloseCount }),
  };
}

test("transaction finalization is single-use and bound to unchanged checkout evidence", async () => {
  let html = "<p>Acme Store</p><p>USD $42.50</p><p>Canvas backpack</p>";
  let clicks = 0;
  const runtime: BrowserRuntime = { launch: async () => ({ id: "tx-session", newPage: async () => ({
    id: "tx-page", url: async () => "https://shop.example/checkout", title: async () => "Checkout", content: async () => html,
    goto: async () => {}, click: async () => { clicks++; }, type: async () => {}, select: async () => {}, scroll: async () => {},
    wait: async () => {}, press: async () => {}, back: async () => {}, forward: async () => {}, reload: async () => {}, screenshot: async () => "", close: async () => {}
  }), close: async () => {} }) };
  const tools = createBrowserTools(runtime), get = (name: string) => tools.find((item) => item.name === name)!;
  await get("browser.open").execute({}, {} as never);
  const inspected = await get("browser.transaction.inspect").execute({ pageId: "tx-page", recipient: "Acme Store", amount: "$42.50", currency: "USD", items: ["Canvas backpack"] }, {} as never) as { verified: boolean; challengeId: string };
  assert.equal(inspected.verified, true);
  await get("browser.transaction.finalize").execute({ pageId: "tx-page", url: "https://shop.example/checkout", challengeId: inspected.challengeId, selector: "button.place-order" }, {} as never);
  assert.equal(clicks, 1);
  await assert.rejects(get("browser.transaction.finalize").execute({ pageId: "tx-page", url: "https://shop.example/checkout", challengeId: inspected.challengeId, selector: "button.place-order" }, {} as never), /missing, expired, or already used/i);
  assert.equal(clicks, 1);
});

test("transaction finalization rejects changed checkout content", async () => {
  let html = "<p>Acme Store</p><p>USD $42.50</p>";
  let clicks = 0;
  const runtime: BrowserRuntime = { launch: async () => ({ id: "tx-change-session", newPage: async () => ({
    id: "tx-change-page", url: async () => "https://shop.example/checkout", title: async () => "Checkout", content: async () => html,
    goto: async () => {}, click: async () => { clicks++; }, type: async () => {}, select: async () => {}, scroll: async () => {},
    wait: async () => {}, press: async () => {}, back: async () => {}, forward: async () => {}, reload: async () => {}, screenshot: async () => "", close: async () => {}
  }), close: async () => {} }) };
  const tools = createBrowserTools(runtime), get = (name: string) => tools.find((item) => item.name === name)!;
  await get("browser.open").execute({}, {} as never);
  const inspected = await get("browser.transaction.inspect").execute({ pageId: "tx-change-page", recipient: "Acme Store", amount: "$42.50", currency: "USD" }, {} as never) as { challengeId: string };
  html += "<p>USD $99.00</p>";
  await assert.rejects(get("browser.transaction.finalize").execute({ pageId: "tx-change-page", url: "https://shop.example/checkout", challengeId: inspected.challengeId, selector: "button.pay" }, {} as never), /page changed after inspection/i);
  assert.equal(clicks, 0);
});

test("browser.close closes only the requested page when pageId is provided", async () => {
  const harness = setup();
  const opened = await harness.tool("browser.open").execute({}, {} as never) as { pageId: string };
  const result = await harness.tool("browser.close").execute({ pageId: opened.pageId }, {} as never);
  assert.deepEqual(result, { ok: true, closed: "page", pageId: opened.pageId });
  assert.deepEqual(harness.counts(), { launchCount: 1, sessionCloseCount: 0, pageCloseCount: 1 });
});

test("browser.close without pageId closes the session and resets it for reuse", async () => {
  const harness = setup();
  const opened = await harness.tool("browser.open").execute({}, {} as never) as { pageId: string };
  const result = await harness.tool("browser.close").execute({}, {} as never);
  assert.deepEqual(result, { ok: true, closed: "session" });
  assert.deepEqual(harness.counts(), { launchCount: 1, sessionCloseCount: 1, pageCloseCount: 0 });
  const reopened = await harness.tool("browser.open").execute({}, {} as never) as { pageId: string };
  assert.notEqual(reopened.pageId, opened.pageId);
  assert.equal(harness.counts().launchCount, 2);
});


test("browser.close removes a page handle even when the runtime close fails", async () => {
  const runtime = {
    launch: async () => ({
      id: "session-failure",
      newPage: async () => ({
        id: "page-failure",
        url: async () => "about:blank",
        title: async () => "",
        content: async () => "",
        goto: async () => {},
        click: async () => {},
        type: async () => {},
        select: async () => {},
        scroll: async () => {},
        wait: async () => {},
        press: async () => {},
        back: async () => {},
        forward: async () => {},
        reload: async () => {},
        screenshot: async () => "",
        close: async () => { throw new Error("page close failed"); },
      } satisfies BrowserPage),
      close: async () => {},
    } satisfies BrowserSession),
  } satisfies BrowserRuntime;
  const tools = createBrowserTools(runtime);
  const open = tools.find((item) => item.name === "browser.open")!;
  const close = tools.find((item) => item.name === "browser.close")!;
  const observe = tools.find((item) => item.name === "browser.observe")!;
  await open.execute({}, {} as never);
  await assert.rejects(close.execute({ pageId: "page-failure" }, {} as never), /page close failed/);
  await assert.rejects(observe.execute({ pageId: "page-failure" }, {} as never), /Unknown browser page/);
});

test("browser.close clears a broken session handle even when session close fails", async () => {
  let launches = 0;
  const runtime = {
    launch: async () => {
      launches++;
      return {
        id: "session-" + launches,
        newPage: async () => ({
          id: "page-" + launches,
          url: async () => "about:blank",
          title: async () => "",
          content: async () => "",
          goto: async () => {},
          click: async () => {},
          type: async () => {},
          select: async () => {},
          scroll: async () => {},
          wait: async () => {},
          press: async () => {},
          back: async () => {},
          forward: async () => {},
          reload: async () => {},
          screenshot: async () => "",
          close: async () => {},
        } satisfies BrowserPage),
        close: async () => { if (launches === 1) throw new Error("session close failed"); },
      } satisfies BrowserSession;
    },
  } satisfies BrowserRuntime;
  const tools = createBrowserTools(runtime);
  const open = tools.find((item) => item.name === "browser.open")!;
  const close = tools.find((item) => item.name === "browser.close")!;
  await open.execute({}, {} as never);
  await assert.rejects(close.execute({}, {} as never), /session close failed/);
  await open.execute({}, {} as never);
  assert.equal(launches, 2);
});


test("run-scoped browser cleanup closes the session even when the model never calls browser.close", async () => {
  let cleanup: (() => Promise<void>) | undefined;
  let launches = 0;
  let closes = 0;
  const runtime = {
    launch: async () => {
      launches++;
      return {
        id: "cleanup-session",
        newPage: async () => ({
          id: "cleanup-page",
          url: async () => "about:blank",
          title: async () => "",
          content: async () => "",
          goto: async () => {},
          click: async () => {},
          type: async () => {},
          select: async () => {},
          scroll: async () => {},
          wait: async () => {},
          press: async () => {},
          back: async () => {},
          forward: async () => {},
          reload: async () => {},
          screenshot: async () => "",
          close: async () => {},
        } satisfies BrowserPage),
        close: async () => { closes++; },
      } satisfies BrowserSession;
    },
  } satisfies BrowserRuntime;
  const tools = createBrowserTools(runtime, (dispose) => { cleanup = dispose; });
  await tools.find((item) => item.name === "browser.open")!.execute({}, {} as never);
  assert.equal(launches, 1);
  assert.ok(cleanup);
  await cleanup!();
  assert.equal(closes, 1);
  // Cleanup is idempotent and must not close the same browser twice.
  await cleanup!();
  assert.equal(closes, 1);
});

test("browser.login keeps the authenticated session available across Brain runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-browser-login-"));
  try {
    const store = new BrowserProfileStore(root);
    const launchOptions: Array<{ profileDirectory?: string; headless?: boolean } | undefined> = [];
    let closeCount = 0;
    const runtime: BrowserRuntime = {
      launch: async (options) => {
        launchOptions.push(options);
        return {
          id: "persistent-session",
          newPage: async () => ({
            id: "persistent-page",
            url: async () => "https://example.com/",
            title: async () => "Example",
            content: async () => "",
            goto: async () => {},
            click: async () => {},
            type: async () => {},
            select: async () => {},
            scroll: async () => {},
            wait: async () => {},
            press: async () => {},
            back: async () => {},
            forward: async () => {},
            reload: async () => {},
            screenshot: async () => "",
            close: async () => {},
          }),
          close: async () => { closeCount++; },
        };
      },
    };
    const manager = new BrowserProfileSessionManager(store, () => runtime);
    let cleanup: (() => Promise<void>) | undefined;
    const firstRun = createBrowserTools(runtime, (dispose) => { cleanup = dispose; }, { profileSessions: manager, ownerId: "principal-a", allowLogin: true });
    const tool = (tools: typeof firstRun, name: string) => {
      const found = tools.find((item) => item.name === name);
      assert.ok(found, "missing browser tool " + name);
      return found;
    };
    const result = await tool(firstRun, "browser.login").execute({ url: "https://example.com/login" }, {} as never) as {
      profileId: string; loginHandoff: string;
    };
    assert.ok(result.profileId);
    assert.match(result.loginHandoff, /visible browser window/);
    assert.equal(launchOptions.length, 1);
    assert.equal(launchOptions[0]?.headless, false);
    assert.ok(launchOptions[0]?.profileDirectory);
    const listed = await tool(firstRun, "browser.profile.list").execute({}, {} as never) as { profiles: Array<Record<string, unknown>> };
    assert.equal(listed.profiles.length, 1);
    assert.equal("directory" in listed.profiles[0]!, false);

    // Brain run cleanup must not close a user-owned persistent login window.
    await cleanup!();
    assert.equal(closeCount, 0);

    // A later Brain run reuses the same authenticated context instead of
    // launching a second Chromium process against the locked profile directory.
    const secondRun = createBrowserTools(runtime, undefined, { profileSessions: manager, ownerId: "principal-a", allowLogin: true });
    await tool(secondRun, "browser.open").execute({ profileId: result.profileId }, {} as never);
    assert.equal(launchOptions.length, 1);
    await assert.rejects(tool(createBrowserTools(runtime, undefined, { profileSessions: manager, ownerId: "principal-b", allowLogin: true }), "browser.open").execute({ profileId: result.profileId }, {} as never));
    await tool(secondRun, "browser.profile.revoke").execute({ profileId: result.profileId }, {} as never);
    assert.equal(closeCount, 1);
    await assert.rejects(store.get("principal-a", result.profileId));
    await manager.closeAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("concurrent browser profile acquisition shares one owner-scoped session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-browser-profile-singleflight-"));
  try {
    const store = new BrowserProfileStore(root);
    const profile = await store.create("principal-a");
    let launches = 0;
    let closes = 0;
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const runtime: BrowserRuntime = {
      launch: async () => {
        launches++;
        await launchGate;
        return {
          id: "singleflight-session",
          newPage: async () => ({
            id: "singleflight-page",
            url: async () => "about:blank",
            title: async () => "",
            content: async () => "",
            goto: async () => {},
            click: async () => {},
            type: async () => {},
            select: async () => {},
            scroll: async () => {},
            wait: async () => {},
            press: async () => {},
            back: async () => {},
            forward: async () => {},
            reload: async () => {},
            screenshot: async () => "",
            close: async () => {},
          }),
          close: async () => { closes++; },
        };
      },
    };
    const manager = new BrowserProfileSessionManager(store, () => runtime);
    const first = manager.acquire("principal-a", profile.id);
    const second = manager.acquire("principal-a", profile.id);
    releaseLaunch();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one, two);
    assert.equal(launches, 1);
    await manager.closeAll();
    assert.equal(closes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser.transaction.inspect returns read-only evidence and fails on mismatches", async () => {
  const html = "<main><h1>Checkout</h1><p>Acme Store</p><p>USD $42.50</p><p>Canvas bag x 1</p></main>";
  const runtime: BrowserRuntime = {
    launch: async () => ({
      id: "transaction-session",
      newPage: async () => ({
        id: "transaction-page", url: async () => "https://shop.example/checkout",
        title: async () => "Checkout", content: async () => html,
        goto: async () => {}, click: async () => {}, type: async () => {},
        select: async () => {}, scroll: async () => {}, wait: async () => {},
        press: async () => {}, back: async () => {}, forward: async () => {},
        reload: async () => {}, screenshot: async () => "", close: async () => {},
      } satisfies BrowserPage),
      close: async () => {},
    } satisfies BrowserSession),
  };
  const tools = createBrowserTools(runtime);
  const open = tools.find((item) => item.name === "browser.open")!;
  const inspect = tools.find((item) => item.name === "browser.transaction.inspect")!;
  assert.deepEqual(inspect.effects, ["read"]);
  const { pageId } = await open.execute({}, {} as never) as { pageId: string };
  const matched = await inspect.execute({
    pageId, recipient: "Acme Store", amount: "$42.50", currency: "USD",
    items: ["Canvas bag x 1"],
  }, {} as never) as { verified: boolean; missing: string[]; url: string };
  assert.equal(matched.verified, true);
  assert.deepEqual(matched.missing, []);
  const mismatch = await inspect.execute({
    pageId, recipient: "Different Store", amount: "$42.50",
  }, {} as never) as { verified: boolean; missing: string[] };
  assert.equal(mismatch.verified, false);
  assert.deepEqual(mismatch.missing, ["recipient"]);
});
