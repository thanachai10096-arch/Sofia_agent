import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import tls from "node:tls";
import { createBrowserEgressProxy } from "../dist/browser/runtime.js";

const proxy = await createBrowserEgressProxy();
const proxyAddress = new URL(proxy.url);
const port = Number(proxyAddress.port);

try {
  const httpStatus = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out testing HTTP egress through the browser proxy.")), 15_000);
    const request = httpRequest({
      host: proxyAddress.hostname,
      port,
      method: "GET",
      path: "http://example.com/",
      headers: { host: "example.com", connection: "close" },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        clearTimeout(timer);
        resolve(response.statusCode ?? 0);
      });
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
  assert.ok(httpStatus >= 200 && httpStatus < 400, "HTTP egress proxy returned status " + httpStatus);

  const httpsStatus = await new Promise((resolve, reject) => {
    const tunnel = connectTcp(port, proxyAddress.hostname);
    let connectResponse = "";
    let responseHeaders = "";
    let secureSocket;
    const timer = setTimeout(() => {
      tunnel.destroy();
      secureSocket?.destroy();
      reject(new Error("Timed out testing HTTPS CONNECT egress through the browser proxy."));
    }, 20_000);
    const fail = (error) => {
      clearTimeout(timer);
      tunnel.destroy();
      secureSocket?.destroy();
      reject(error);
    };
    tunnel.once("error", fail);
    tunnel.once("connect", () => tunnel.write("CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n"));
    const onConnectData = (chunk) => {
      connectResponse += chunk.toString("latin1");
      const boundary = connectResponse.indexOf("\\r\\n\\r\\n");
      if (boundary < 0) return;
      tunnel.removeListener("data", onConnectData);
      const statusLine = connectResponse.slice(0, boundary).split("\\r\\n")[0] ?? "";
      if (!/^HTTP\\/1\\.1 200 /.test(statusLine)) {
        fail(new Error("HTTPS CONNECT was rejected: " + statusLine));
        return;
      }
      secureSocket = tls.connect({ socket: tunnel, servername: "example.com" }, () => {
        secureSocket.write("GET / HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n");
      });
      secureSocket.once("error", fail);
      secureSocket.on("data", (data) => {
        responseHeaders += data.toString("latin1");
        const responseBoundary = responseHeaders.indexOf("\\r\\n\\r\\n");
        if (responseBoundary < 0) return;
        const responseLine = responseHeaders.slice(0, responseBoundary).split("\\r\\n")[0] ?? "";
        const match = /^HTTP\\/1\\.1 (\\d{3})/.exec(responseLine);
        clearTimeout(timer);
        secureSocket.destroy();
        if (!match) reject(new Error("Invalid HTTPS response status line: " + responseLine));
        else resolve(Number(match[1]));
      });
    };
    tunnel.on("data", onConnectData);
  });
  assert.ok(httpsStatus >= 200 && httpsStatus < 400, "HTTPS egress proxy returned status " + httpsStatus);
  process.stdout.write("Browser egress proxy live smoke passed: public HTTP and HTTPS requests succeeded through DNS-pinned connections.\\n");
} finally {
  await proxy.close();
}
