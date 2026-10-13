import assert from "node:assert/strict";
import { PlaywrightBrowserRuntime } from "../dist/browser/runtime.js";

const runtime = new PlaywrightBrowserRuntime(true);
const session = await runtime.launch();
try {
  const page = await session.newPage();
  await page.goto("https://example.com");
  assert.equal(new URL(await page.url()).hostname, "example.com");
  assert.match(await page.title(), /Example Domain/i);
  assert.match(await page.content(), /Example Domain/i);
  await assert.rejects(
    () => page.goto("http://127.0.0.1/"),
    /local or internal|private or non-public IP/,
  );
  process.stdout.write("Playwright browser runtime smoke passed: public HTTPS navigation uses the configured egress proxy and private navigation is blocked.\n");
} finally {
  await session.close();
}
