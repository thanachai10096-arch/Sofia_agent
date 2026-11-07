import assert from "node:assert/strict";
import test from "node:test";
import { createLocalGuiApproval } from "./gui-approval.js";

test("GUI approval is loopback-bound and requires the exact one-time token", async () => {
  let approvalUrl = "";
  const ui = createLocalGuiApproval({
    timeoutMs: 10_000,
    openUrl: async (url) => { approvalUrl = url; },
  });
  const pending = ui.requestApproval({
    kind: "app.launch", applicationId: "editor", args: ["--safe"],
  });
  try {
    for (let i = 0; i < 20 && !approvalUrl; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(approvalUrl, /^http:\/\/127\.0\.0\.1:\d+\/#/);
    const url = new URL(approvalUrl);
    const token = url.hash.slice(1);
    const page = await fetch(url.origin + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /editor/);
    const rejected = await fetch(url.origin + "/decision", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
        "x-sofia-approval-token": token,
      },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(rejected.status, 403);
    const accepted = await fetch(url.origin + "/decision", {
      method: "POST",
      headers: {
        origin: url.origin,
        "content-type": "application/json",
        "x-sofia-approval-token": token,
      },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(await pending, true);
    const replay = await fetch(url.origin + "/decision", {
      method: "POST",
      headers: {
        origin: url.origin,
        "content-type": "application/json",
        "x-sofia-approval-token": token,
      },
      body: JSON.stringify({ decision: "approve" }),
    }).catch(() => null);
    assert.equal(replay, null);
  } finally {
    await ui.close();
  }
});

test("GUI approval denies on local abort and does not open an external listener", async () => {
  let approvalUrl = "";
  const ui = createLocalGuiApproval({ openUrl: async (url) => { approvalUrl = url; } });
  const controller = new AbortController();
  const pending = ui.requestApproval({ kind: "app.launch", applicationId: "browser", args: [] }, controller.signal);
  for (let i = 0; i < 20 && !approvalUrl; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(approvalUrl, /^http:\/\/127\.0\.0\.1:/);
  controller.abort();
  assert.equal(await pending, false);
  await ui.close();
});
