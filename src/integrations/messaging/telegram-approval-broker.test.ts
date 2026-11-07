import assert from "node:assert/strict";
import test from "node:test";
import { TelegramApprovalBroker } from "./telegram-approval-broker.js";

function approvalRequest() {
  return {
    runId: "run-123",
    principalId: "api-owner",
    toolName: "workspace.write_file",
    input: { path: "src/new-file.txt", content: "hello" },
    actionHash: "bound-action-hash",
    risk: "medium" as const,
  };
}

test("approval can arrive before Telegram registers the originating run", async () => {
  let prompt = "";
  const broker = new TelegramApprovalBroker({
    routeWaitMs: 1_000,
    approvalTimeoutMs: 2_000,
    send: async (_chat, text) => { prompt = text; return true; },
  });
  const decision = broker.handleApproval(approvalRequest());
  broker.registerRun("run-123", { userId: "1001", conversationId: "-2001" });
  await new Promise((resolve) => setImmediate(resolve));
  const code = prompt.match(/\/approve ([a-f0-9]{32})/)?.[1];
  assert.ok(code);
  assert.match(prompt, /workspace\.write_file/);

  assert.equal(broker.handleCommand({ userId: "1002", conversationId: "-2001", text: "/approve " + code }), "คุณไม่มีสิทธิ์ตอบรับคำขออนุมัตินี้");
  assert.equal(broker.handleCommand({ userId: "1001", conversationId: "-2002", text: "/approve " + code }), "คุณไม่มีสิทธิ์ตอบรับคำขออนุมัตินี้");
  assert.equal(broker.handleCommand({ userId: "1001", conversationId: "-2001", text: "/approve " + code }), "✅ อนุมัติแล้ว Sofia จะดำเนินการต่อ");
  assert.equal(await decision, true);
  assert.equal(broker.handleCommand({ userId: "1001", conversationId: "-2001", text: "/approve " + code }), "คำขออนุมัตินี้หมดอายุหรือถูกใช้ไปแล้ว");
  broker.close();
});

test("denial is one-time and bound to the requesting Telegram user", async () => {
  let prompt = "";
  const broker = new TelegramApprovalBroker({
    send: async (_chat, text) => { prompt = text; return true; },
  });
  broker.registerRun("run-123", { userId: "1001", conversationId: "-2001" });
  const decision = broker.handleApproval(approvalRequest());
  await new Promise((resolve) => setImmediate(resolve));
  const code = prompt.match(/\/deny ([a-f0-9]{32})/)?.[1];
  assert.ok(code);
  assert.equal(broker.handleCommand({ userId: "1001", conversationId: "-2001", text: "/deny " + code }), "⛔ ปฏิเสธแล้ว Sofia จะไม่ดำเนินการ");
  assert.equal(await decision, false);
  broker.close();
});

test("approval fails closed when no originating Telegram route is registered", async () => {
  const broker = new TelegramApprovalBroker({ routeWaitMs: 100 });
  assert.equal(await broker.handleApproval(approvalRequest()), false);
  broker.close();
});

test("closing the broker denies outstanding approvals", async () => {
  let prompt = "";
  const broker = new TelegramApprovalBroker({
    send: async (_chat, text) => { prompt = text; return true; },
  });
  broker.registerRun("run-123", { userId: "1001", conversationId: "-2001" });
  const decision = broker.handleApproval(approvalRequest());
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(prompt, /\/approve/);
  broker.close();
  assert.equal(await decision, false);
});
