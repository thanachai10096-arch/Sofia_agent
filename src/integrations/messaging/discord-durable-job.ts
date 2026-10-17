import type { JobRecord, JobRuntime } from "../../brain/job-runtime.js";

export interface DiscordDurableJobResult {
  id: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
}

export interface DiscordDurableJobHandle {
  id: string;
  runtime: JobRuntime;
}

/** Submit a task without holding the Discord interaction open for the full job. */
export async function submitDiscordTask(
  runtime: JobRuntime,
  task: string,
  principalId: string,
  signal?: AbortSignal,
): Promise<DiscordDurableJobHandle> {
  if (!task.trim()) throw new Error("Discord task is required.");
  if (!principalId.trim()) throw new Error("Discord principal is required.");
  signal?.throwIfAborted();
  const submitted = await runtime.submit({ task, principalId, ownerKeyId: principalId });
  return { id: submitted.id, runtime };
}

/** Poll durable state independently of the short-lived Discord interaction token. */
export async function waitForDiscordTask(
  handle: DiscordDurableJobHandle,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<DiscordDurableJobResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 30_000) {
    throw new Error("Invalid Discord job polling interval.");
  }
  options.signal?.throwIfAborted();
  let current: JobRecord | undefined;
  do {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(options.signal?.reason ?? new Error("Discord job polling aborted."));
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, pollIntervalMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
    options.signal?.throwIfAborted();
    current = await handle.runtime.get(handle.id);
    if (!current) throw new Error("Sofia job state is unavailable.");
  } while (current.status === "queued" || current.status === "running");

  if (current.status === "completed") {
    return { id: current.id, status: "completed", summary: current.result?.summary?.trim() || "Sofia completed the task." };
  }
  return {
    id: current.id,
    status: current.status,
    summary: current.error?.trim() || (current.status === "cancelled" ? "Sofia job was cancelled." : "Sofia job failed."),
  };
}

/** Convenience API for callers that intentionally want to wait for completion. */
export async function runDiscordTaskAsDurableJob(
  runtime: JobRuntime,
  task: string,
  principalId: string,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<DiscordDurableJobResult> {
  const handle = await submitDiscordTask(runtime, task, principalId, options.signal);
  return waitForDiscordTask(handle, options);
}
