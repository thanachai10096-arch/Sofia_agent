import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import test from "node:test";
import { assertSafeBrowserUrl, createBrowserEgressProxy, resolvePublicHostAddress } from "./runtime.js";

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


test("browser URL policy rejects non-standard web ports", () => {
  for (const url of ["http://example.com:8080/", "https://example.com:8443/", "http://example.com:443/"]) {
    assert.throws(() => assertSafeBrowserUrl(url), /standard HTTP port 80 and HTTPS port 443/);
  }
});

test("pinned browser resolver rejects private literals and preserves public IP literals", async () => {
  await assert.rejects(() => resolvePublicHostAddress("127.0.0.1"), /private or non-public IP/);
  await assert.rejects(() => resolvePublicHostAddress("169.254.169.254"), /private or non-public IP/);
  assert.equal(await resolvePublicHostAddress("8.8.8.8"), "8.8.8.8");
});

test("browser egress proxy blocks HTTP requests to private IP literals", async () => {
  const proxy = await createBrowserEgressProxy();
  const address = new URL(proxy.url);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: address.hostname,
        port: Number(address.port),
        method: "GET",
        path: "http://127.0.0.1/",
        headers: { host: "127.0.0.1" },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(status, 403);
  } finally {
    await proxy.close();
  }
});

test("browser egress proxy blocks CONNECT requests to private IP literals", async () => {
  const proxy = await createBrowserEgressProxy();
  const address = new URL(proxy.url);
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connectTcp(Number(address.port), address.hostname);
      let output = "";
      const timer = setTimeout(() => socket.destroy(new Error("Timed out waiting for proxy policy response.")), 3000);
      socket.once("connect", () => socket.write("CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n"));
      socket.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (output.includes("\r\n\r\n")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(output);
        }
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
  } finally {
    await proxy.close();
  }
});
