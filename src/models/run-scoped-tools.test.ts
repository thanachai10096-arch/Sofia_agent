import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunScopedToolRegistry } from "./run-scoped-tools.js";
import type { BrowserRuntime } from "../browser/runtime.js";

function fakeBrowserRuntime(onClose: () => void): BrowserRuntime {
  return {
    async launch() {
      return {
        id: "browser-session",
        async newPage() {
          return {
            id: "browser-page",
            async url() { return "about:blank"; },
            async title() { return "Blank"; },
            async content() { return ""; },
            async goto() {},
            async click() {},
            async type() {},
            async select() {},
            async scroll() {},
            async wait() {},
            async press() {},
            async back() {},
            async forward() {},
            async reload() {},
            async screenshot() { return ""; },
            async close() {},
          };
        },
        async close() { onClose(); },
      };
    },
  } as unknown as BrowserRuntime;
}

test("run-scoped registry includes Browser tools only when policy enables them and cleans them up", async () => {
  let browserClosed = 0;
  const base = [{ name: "workspace.read_file", description: "Read", inputSchema: { type: "object" }, async execute() { return {}; } }];
  const disabled = createRunScopedToolRegistry({
    baseTools: base,
    allowBrowser: false,
    browserRuntime: fakeBrowserRuntime(() => { browserClosed++; }),
    workspaceRoot: process.cwd(),
  });
  assert.equal(disabled.registry.get("browser.open"), undefined);
  await disabled.cleanup();
  assert.equal(browserClosed, 0);

  const enabled = createRunScopedToolRegistry({
    baseTools: base,
    allowBrowser: true,
    browserRuntime: fakeBrowserRuntime(() => { browserClosed++; }),
    workspaceRoot: process.cwd(),
  });
  const opened = await enabled.registry.get("browser.open")!.execute({}, {} as never) as { pageId: string };
  assert.equal(opened.pageId, "browser-page");
  await enabled.cleanup();
  assert.equal(browserClosed, 1);
  assert.ok(enabled.registry.get("browser.goto"));
});

test("run-scoped registry adds Desktop tools only for trusted capabilities and enforces them at execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-run-tools-"));
  try {
    await writeFile(path.join(root, "hello.txt"), "hello");
    const base = [{ name: "workspace.read_file", description: "Read", inputSchema: { type: "object" }, async execute() { return {}; } }];
    const none = createRunScopedToolRegistry({
      baseTools: base,
      allowBrowser: false,
      browserRuntime: fakeBrowserRuntime(() => {}),
      workspaceRoot: root,
    });
    assert.equal(none.registry.get("desktop.workspace.read_file"), undefined);

    const reader = createRunScopedToolRegistry({
      baseTools: base,
      allowBrowser: false,
      browserRuntime: fakeBrowserRuntime(() => {}),
      desktopCapabilities: ["workspace:read"],
      principalId: "authenticated-reader",
      workspaceRoot: root,
    });
    const read = reader.registry.get("desktop.workspace.read_file");
    const write = reader.registry.get("desktop.workspace.write_file");
    assert.ok(read);
    assert.ok(write);
    assert.deepEqual(await read.execute({ path: "hello.txt" }, {} as never), { path: "hello.txt", content: "hello" });
    await assert.rejects(write.execute({ path: "new.txt", content: "no" }, {} as never), /not permitted/);
    await reader.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
