import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeBrowserUrl } from "./runtime.js";

test("browser URL policy allows public HTTP(S) destinations", () => {
  assert.equal(assertSafeBrowserUrl("https://example.com/path").hostname, "example.com");
  assert.equal(assertSafeBrowserUrl("http://8.8.8.8/").hostname, "8.8.8.8");
  assert.equal(assertSafeBrowserUrl("http://[2606:4700:4700::1111]/").hostname, "[2606:4700:4700::1111]");
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
    "http://192.0.0.1", "http://192.0.0.9", "http://192.0.0.10", "http://192.0.0.255", "http://192.31.196.1", "http://192.52.193.1",
    "http://192.168.1.1", "http://192.88.99.1", "http://192.175.48.1", "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1", "http://2130706433", "http://0x7f000001", "http://0177.0.0.1",
    "http://[::1]", "http://[fd00::1]",
    "http://[64:ff9b::a00:1]", "http://[64:ff9b:1::a00:1]",
    "http://metadata.google.internal", "http://metadata",
    "http://host.test", "http://host.example", "http://host.invalid",
    "http://[2001:0::1]", "http://[2001:100::1]", "http://[2002:c0a8:101::1]", "http://[3fff::1]",
  ]) {
    assert.throws(() => assertSafeBrowserUrl(url), /local or internal|private or non-public/);
  }
});
