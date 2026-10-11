import assert from "node:assert/strict";
import test from "node:test";
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
  const close = tools.find((item) => item.name === "browser.close")!;
  const observe = tools.find((item) => item.name === "browser.observe")!;
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
