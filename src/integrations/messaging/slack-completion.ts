import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AgentRunInput, AgentRunResponse } from "../../api/types.js";
import { redactSecrets } from "../../security/guard.js";

export type SlackCompletionEnvironment = Record<string, string | undefined>;

function parseSlackAllowlist(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((entry) => entry.trim())
    .filter((entry) => /^[A-Z0-9]{1,32}$/.test(entry)));
}

/**
 * Create a best-effort Slack completion notifier for signed Slack-originated runs.
 * The proof binds the originating thread and exact task text, and is checked again
 * here so callers cannot forge a destination by supplying arbitrary run context.
 */
export function createSlackCompletionNotifier(
  env: SlackCompletionEnvironment,
  fetchImpl: typeof fetch = fetch,
): (run: AgentRunResponse, input: AgentRunInput) => Promise<void> {
  return async (run, input): Promise<void> => {
    const context = input.context;
    if (typeof context !== "string") return;
    const match = context.match(/^Origin: Slack message event\. Slack user ID: ([A-Z0-9]{1,32})\. Channel ID: ([A-Z0-9]{1,32})\. Message timestamp: (\d{1,16}(?:\.\d{1,9})?)\. Callback signature: ([a-f0-9]{64})\.$/);
    if (!match) return;
    const [, userId, channelId, threadTs, signature] = match;
    const callbackSecret = env.SOFIA_SLACK_CALLBACK_SECRET?.trim();
    if (!callbackSecret || callbackSecret.length < 32) return;

    const taskDigest = createHash("sha256").update(input.task).digest("hex");
    const expected = createHmac("sha256", callbackSecret)
      .update(`${userId}|${channelId}|${threadTs}|${taskDigest}`).digest();
    const supplied = Buffer.from(signature!, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return;
    if (!parseSlackAllowlist(env.SLACK_ALLOWED_USER_IDS).has(userId!) ||
        !parseSlackAllowlist(env.SLACK_ALLOWED_CHANNEL_IDS).has(channelId!)) return;

    const token = env.SLACK_BOT_TOKEN;
    if (!token || !/^xox[baprs]-[A-Za-z0-9-]{10,512}$/.test(token)) return;

    const status = ["completed", "failed", "cancelled"].includes(run.status) ? run.status : "unknown";
    const output = status === "completed" && typeof run.result?.output === "string"
      ? String(redactSecrets(run.result.output)).trim().slice(0, 2_500)
      : "";
    const error = typeof run.error === "string"
      ? String(redactSecrets(run.error)).replace(/[\r\n\t]+/g, " ").slice(0, 240).trim()
      : "";
    const text = status === "completed"
      ? "✅ Sofia completed the task.\nRun ID: " + run.id + (output ? "\n\n" + output : "\n\nThe run completed without text output.")
      : "Sofia task " + status + ".\nRun ID: " + run.id + (error ? "\nReason: " + error : "");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: channelId, thread_ts: threadTs, text }),
        signal: controller.signal,
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({})) as { ok?: unknown };
      if (payload.ok !== true) return;
    } catch {
      // Run state is authoritative; Slack notification delivery is best-effort.
    } finally {
      clearTimeout(timer);
    }
  };
}
