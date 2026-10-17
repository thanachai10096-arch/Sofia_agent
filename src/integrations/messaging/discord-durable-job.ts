import type { JobRecord, JobRuntime } from "../../brain/job-runtime.js";

export interface DiscordDurableJobResult {
  id: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
}

/**
 * Submit a Discord task to Sofia's existing durable job runtime.
 * The job runtime owns checkpoint persistence and interruption recovery; this
 * adapter only polls its status and does not duplicate execution state.
 */
export async function runDiscordTaskAsDurableJob(
  runtime: JobRuntime,
  task: string,
  principalId: string,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<DiscordDurableJobResult> {
  if (!task.trim()) throw new Error("Discord task is required.");
  if (!principalId.trim()) throw new Error("Discord principal is required.");
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 30_000) {
    throw new Error("Invalid Discord job polling interval.");
  }
  options.signal?.throwIfAborted();

  const submitted = await runtime.submit({
    task,
    principalId,
    ownerKeyId: principalId,
  });
  let current: JobRecord = submitted;

  while (current.status === "queued" || current.status === "running") {
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      if (pollIntervalMs === 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, pollIntervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(options.signal?.reason ?? new Error("Discord job polling aborted."));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    options.signal?.throwIfAborted();
    const refreshed = await runtime.get(submitted.id);
    if (!refreshed) throw new Error("Sofia job state is unavailable.");
    current = refreshed;
  }

  if (current.status === "completed") {
    return {
      id: current.id,
      status: "completed",
      summary: current.result?.summary?.trim() || "Sofia completed the task.",
    };
  }
  return {
    id: current.id,
    status: current.status,
    summary: current.error?.trim() || (current.status === "cancelled" ? "Sofia job was cancelled." : "Sofia job failed."),
  };
}
