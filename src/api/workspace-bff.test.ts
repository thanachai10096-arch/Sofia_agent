import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalInbox } from "../agent/approval-inbox.js";
import { FileApprovalAuditStore } from "../agent/approval-audit-store.js";
import type { WorkspaceOidcAuth } from "./workspace-oidc-auth.js";
import { createSofiaApi } from "./server.js";

const route = {
  id: "workspace-bff-test", capabilities: ["fast" as const], costWeight: 1,
  latencyWeight: 1, qualityWeight: 1, healthy: true,
};
const csrf = "c".repeat(43);
const sessionCookie = "__Host-sofia_workspace=valid-session";
const csrfCookie = "__Host-sofia_csrf=" + csrf;

test("Mobile Workspace serves protected PWA and proxies only same-origin scoped API routes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-workspace-bff-"));
  const assets = path.join(root, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(assets, "index.html"), "<main>private workspace</main>");
  writeFileSync(path.join(assets, "login.html"), "<main>sign in</main>");
  writeFileSync(path.join(assets, "service-worker.js"), "self.addEventListener('install', () => undefined);");
  writeFileSync(path.join(assets, "workspace.css"), "body { color: black; }");
  const auditStore = new FileApprovalAuditStore(path.join(root, ".sofia"));
  const inbox = new ApprovalInbox();
  const fakeAuth = {
    cookieName: "__Host-sofia_workspace",
    authenticate: (cookie: string | undefined) => cookie?.includes(sessionCookie)
      ? { subject: "operator", sessionId: "valid-session", expiresAt: Date.now() + 60_000 }
      : null,
    beginLogin: async () => ({ url: "https://identity.example.test/authorize", state: "test-state" }),
    completeLogin: async () => ({ subject: "operator", sessionId: "valid-session", expiresAt: Date.now() + 60_000 }),
    sessionCookie: () => sessionCookie + "; Path=/; HttpOnly; Secure; SameSite=Lax",
    revoke: () => undefined,
    clearCookie: () => "__Host-sofia_workspace=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  } as unknown as WorkspaceOidcAuth;
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: { "server-key": ["approval:read", "approval:decide"] },
    approvalInbox: inbox, approvalAuditStore: auditStore,
    workspaceAuth: fakeAuth, workspaceApiKey: "server-key", workspaceStaticDirectory: assets,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const origin = base;
  const cookie = sessionCookie + "; " + csrfCookie;
  try {
    const rootRedirect = await fetch(base + "/workspace/", { redirect: "manual" });
    assert.equal(rootRedirect.status, 302);
    assert.equal(rootRedirect.headers.get("location"), "/workspace/login.html");
    const failedLogin = await fetch(base + "/workspace/?auth=failed", { redirect: "manual" });
    assert.equal(failedLogin.headers.get("location"), "/workspace/login.html?auth=failed");

    const login = await fetch(base + "/workspace/auth/login", { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "https://identity.example.test/authorize");

    const protectedPage = await fetch(base + "/workspace/index.html", { redirect: "manual" });
    assert.equal(protectedPage.status, 302);
    assert.equal(protectedPage.headers.get("location"), "/workspace/login.html");

    const page = await fetch(base + "/workspace/index.html", { headers: { cookie: sessionCookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /private workspace/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self'/);
    assert.match(page.headers.get("permissions-policy") ?? "", /camera=\(\)/);

    const loginPage = await fetch(base + "/workspace/login.html");
    assert.equal(loginPage.status, 200);
    assert.equal(loginPage.headers.get("cache-control"), "no-store");

    const worker = await fetch(base + "/workspace/service-worker.js");
    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get("cache-control"), "no-store");
    assert.equal(worker.headers.get("service-worker-allowed"), "/workspace/");

    const stylesheet = await fetch(base + "/workspace/workspace.css");
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers.get("cache-control"), "public, max-age=300");

    const logoutRejected = await fetch(base + "/workspace/auth/logout", {
      method: "POST", headers: { cookie, origin },
    });
    assert.equal(logoutRejected.status, 403);

    const logout = await fetch(base + "/workspace/auth/logout", {
      method: "POST", headers: { cookie, origin, "x-csrf-token": csrf },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);

    const audit = await fetch(base + "/api/sofia/v1/approvals/audit", {
      headers: { cookie, origin, "sec-fetch-site": "same-origin" },
    });
    assert.equal(audit.status, 200);
    assert.deepEqual((await audit.json() as { events: unknown[] }).events, []);

    const rejected = await fetch(base + "/api/sofia/v1/approvals/11111111-1111-4111-8111-111111111111/decision", {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", actionHash: "a".repeat(64) }),
    });
    assert.equal(rejected.status, 403);

    const proxied = await fetch(base + "/api/sofia/v1/approvals/11111111-1111-4111-8111-111111111111/decision", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ decision: "approve", actionHash: "a".repeat(64) }),
    });
    assert.equal(proxied.status, 409);

    const forbiddenPath = await fetch(base + "/api/sofia/v1/memory", {
      headers: { cookie, origin, "sec-fetch-site": "same-origin" },
    });
    assert.equal(forbiddenPath.status, 404);
  } finally {
    inbox.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
