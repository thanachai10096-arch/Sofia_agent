import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeBrowserUrl } from "./runtime.js";

test("browser URL guard rejects localhost and reserved local hostnames", async () => {
  await assert.rejects(assertSafeBrowserUrl("http://localhost/"), /local or reserved/);
  await assert.rejects(assertSafeBrowserUrl("http://printer.local/"), /local or reserved/);
  await assert.rejects(assertSafeBrowserUrl("http://service.internal/"), /local or reserved/);
});

test("browser URL guard rejects private, loopback, link-local and reserved IPv4 targets", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1"]) {
    await assert.rejects(assertSafeBrowserUrl("http://" + address + "/"), /private or non-public/);
  }
});

test("browser URL guard rejects non-public IPv6 targets", async () => {
  await assert.rejects(assertSafeBrowserUrl("http://[::1]/"), /private or non-public/);
  await assert.rejects(assertSafeBrowserUrl("http://[fc00::1]/"), /private or non-public/);
  await assert.rejects(assertSafeBrowserUrl("http://[fe80::1]/"), /private or non-public/);
});

test("browser URL guard rejects unsafe protocols and URL credentials", async () => {
  await assert.rejects(assertSafeBrowserUrl("file:///etc/passwd"), /unsupported browser URL protocol/);
  await assert.rejects(assertSafeBrowserUrl("https://user:pass@example.com/"), /containing credentials/);
});

test("browser URL guard permits public literal IP addresses", async () => {
  await assert.doesNotReject(assertSafeBrowserUrl("https://8.8.8.8/"));
  await assert.doesNotReject(assertSafeBrowserUrl("https://[2606:4700:4700::1111]/"));
});
