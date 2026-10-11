import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeBrowserUrl } from "./runtime.js";

test("browser URL policy allows public HTTP(S) destinations", () => {
  assert.equal(assertSafeBrowserUrl("https://example.com/path").hostname, "example.com");
  assert.equal(assertSafeBrowserUrl("http://8.8.8.8/").hostname, "8.8.8.8");
});

test("browser URL policy rejects non-web schemes and URL credentials", () => {
  for (const url of ["file:///etc/passwd", "data:text/html,hello", "javascript:alert(1)", "https://user:pass@example.com"]) {
    assert.throws(() => assertSafeBrowserUrl(url), /only supports HTTP and HTTPS|embedded URL credentials/);
  }
});

test("browser URL policy rejects local, private and metadata destinations", () => {
  for (const url of [
    "http://localhost", "http://service.local", "http://api.internal",
    "http://127.0.0.1", "http://10.1.2.3", "http://172.16.0.1",
    "http://192.168.1.1", "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1", "http://[::1]", "http://[fd00::1]",
    "http://metadata.google.internal", "http://metadata",
    "http://host.test", "http://host.example", "http://host.invalid",
    "http://[2001:0::1]", "http://[2001:200::1]", "http://[2002:c0a8:101::1]", "http://[3fff::1]",
  ]) {
    assert.throws(() => assertSafeBrowserUrl(url), /local or internal|private or non-public/);
  }
});
