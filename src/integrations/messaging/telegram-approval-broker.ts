import { randomUUID } from "node:crypto";
import type { ApprovalHandler, ApprovalRequest } from "../../agent/approval.js";
import { redactSecrets } from "../../security/guard.js";

export interface TelegramApprovalRoute {
  userId: string;
  conversationId: string;
}

export interface TelegramApprovalBrokerOptions {
  send?: (conversationId: string, text: string) => Promise<boolean>;
  routeWaitMs?: number;
  approvalTimeoutMs?: number;
  maxPending?: number;
}

/**
 * One-time, run-scoped Telegram approval broker.
 * A decision is accepted only from the same Telegram user and conversation
 * that submitted the run. Tokens are random, short-lived, and consumed once.
 */
export class TelegramApprovalBroker {
  private sender?: (conversationId: string, text: string) => Promise<boolean>;
  private readonly routes = new Map<string, TelegramApprovalRoute>();
  private readonly routeWaiters = new Map<string, Set<(route: TelegramApprovalRoute | undefined) => void>>();
  private readonly pending = new Map<string, {
    runId: string;
    route: TelegramApprovalRoute;
    actionHash: string;
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly routeWaitMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly maxPending: number;

  constructor(options: TelegramApprovalBrokerOptions = {}) {
    this.sender = options.send;
    this.routeWaitMs = options.routeWaitMs ?? 15_000;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.maxPending = options.maxPending ?? 64;
    if (!Number.isSafeInteger(this.routeWaitMs) || this.routeWaitMs < 100 || this.routeWaitMs > 60_000) {
      throw new Error("Invalid Telegram approval route wait.");
    }
    if (!Number.isSafeInteger(this.approvalTimeoutMs) || this.approvalTimeoutMs < 1_000 || this.approvalTimeoutMs > 15 * 60_000) {
      throw new Error("Invalid Telegram approval timeout.");
    }
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 1_000) {
      throw new Error("Invalid Telegram approval capacity.");
    }
  }

  setSender(send: (conversationId: string, text: string) => Promise<boolean>): void {
    this.sender = send;
  }

  registerRun(runId: string, route: TelegramApprovalRoute): void {
    if (!runId || !/^\d{1,20}$/.test(route.userId) || !/^-?\d{1,20}$/.test(route.conversationId)) return;
    this.routes.set(runId, { ...route });
    const waiters = this.routeWaiters.get(runId);
    if (waiters) {
      this.routeWaiters.delete(runId);
      for (const resolve of waiters) resolve({ ...route });
    }
    // Bound retained routing metadata even if an external run never reports completion.
    while (this.routes.size > 10_000) {
      const oldest = this.routes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.routes.delete(oldest);
    }
  }

  releaseRun(runId: string): void {
    this.routes.delete(runId);
    for (const [code, item] of this.pending) {
      if (item.runId !== runId) continue;
      clearTimeout(item.timer);
      this.pending.delete(code);
      item.resolve(false);
    }
  }

  private async routeFor(runId: string): Promise<TelegramApprovalRoute | undefined> {
    const known = this.routes.get(runId);
    if (known) return { ...known };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (route?: TelegramApprovalRoute) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.routeWaiters.get(runId);
        waiters?.delete(onRoute);
        if (waiters?.size === 0) this.routeWaiters.delete(runId);
        resolve(route);
      };
      const onRoute = (route: TelegramApprovalRoute | undefined) => finish(route);
      const timer = setTimeout(() => finish(undefined), this.routeWaitMs);
      const waiters = this.routeWaiters.get(runId) ?? new Set<(route: TelegramApprovalRoute | undefined) => void>();
      waiters.add(onRoute);
      this.routeWaiters.set(runId, waiters);
      const raced = this.routes.get(runId);
      if (raced) finish(raced);
    });
  }

  readonly handleApproval: ApprovalHandler = async (request) => {
    if (!this.sender || this.pending.size >= this.maxPending) return false;
    const route = await this.routeFor(request.runId);
    if (!route || !this.sender || this.pending.size >= this.maxPending) return false;

    const code = randomUUID().replace(/-/g, "");
    const action = String(redactSecrets(request.input) === undefined ? "{}" : JSON.stringify(redactSecrets(request.input)) ?? "{}").slice(0, 1_000);
    const prompt = [
      "🔐 Sofia ขออนุมัติก่อนดำเนินการ",
      "เครื่องมือ: " + request.toolName,
      "ระดับความเสี่ยง: " + request.risk,
      "รายละเอียด: " + action,
      "",
      "อนุมัติ: /approve " + code,
      "ปฏิเสธ: /deny " + code,
      "คำขอนี้หมดอายุใน 2 นาที และใช้ได้ครั้งเดียว",
    ].join("\n");

    return new Promise<boolean>(async (resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(code);
        resolve(false);
      }, this.approvalTimeoutMs);
      this.pending.set(code, {
        runId: request.runId,
        route,
        actionHash: request.actionHash,
        resolve: (approved) => {
          clearTimeout(timer);
          this.pending.delete(code);
          resolve(approved);
        },
        timer,
      });
      try {
        const delivered = await this.sender!(route.conversationId, prompt);
        if (!delivered) {
          clearTimeout(timer);
          this.pending.delete(code);
          resolve(false);
        }
      } catch {
        clearTimeout(timer);
        this.pending.delete(code);
        resolve(false);
      }
    });
  };

  /** Returns a user-facing reply only for approval commands; undefined means normal chat. */
  handleCommand(input: { userId: string; conversationId: string; text: string }): string | undefined {
    const match = input.text.trim().match(/^\/(approve|deny)(?:@[A-Za-z0-9_]+)?\s+([a-f0-9]{32})$/i);
    if (!match) return undefined;
    const code = match[2].toLowerCase();
    const item = this.pending.get(code);
    if (!item) return "คำขออนุมัตินี้หมดอายุหรือถูกใช้ไปแล้ว";
    if (item.route.userId !== input.userId || item.route.conversationId !== input.conversationId) {
      return "คุณไม่มีสิทธิ์ตอบรับคำขออนุมัตินี้";
    }
    const approved = match[1].toLowerCase() === "approve";
    item.resolve(approved);
    return approved ? "✅ อนุมัติแล้ว Sofia จะดำเนินการต่อ" : "⛔ ปฏิเสธแล้ว Sofia จะไม่ดำเนินการ";
  }

  close(): void {
    for (const [code, item] of this.pending) {
      clearTimeout(item.timer);
      this.pending.delete(code);
      item.resolve(false);
    }
    this.routes.clear();
    for (const waiters of this.routeWaiters.values()) {
      for (const resolve of waiters) resolve(undefined);
    }
    this.routeWaiters.clear();
  }
}
