import type { DesktopAction, DesktopCapability, DesktopHostDriver } from "./types.js";
import type { DesktopCommandJournal, DesktopCommandOutcome } from "./command-journal.js";
import { assertDesktopAction, type DesktopCompanionCommand } from "./remote-command-broker.js";

export interface DesktopCompanionCredentialStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

export interface DesktopCompanionClientConfig {
  apiBaseUrl: string;
  credentials: DesktopCompanionCredentialStore;
  driver: DesktopHostDriver;
  allowedCapabilities: readonly DesktopCapability[];
  allowedApplications?: readonly string[];
  requestApproval: (action: DesktopAction, signal?: AbortSignal) => Promise<boolean>;
  /** Durable local journal for side-effecting actions; recommended for CLI/Desktop use. */
  journal?: DesktopCommandJournal;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DesktopCompanionClient {
  pair(apiKey: string): Promise<{ connectedAt: number }>;
  pollOnce(signal?: AbortSignal): Promise<boolean>;
  start(signal?: AbortSignal): Promise<void>;
  stop(): void;
  disconnect(apiKey: string): Promise<void>;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Desktop Companion API URL is invalid."); }
  const localHttp = url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Desktop Companion requires HTTPS (HTTP is allowed only for loopback development).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Desktop Companion API URL must not contain credentials, query, or fragment.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const maxBytes = 1024 * 1024;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Desktop Companion response is too large.");
  }

  const reader = response.body?.getReader();
  let text = "";
  if (reader) {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error("Desktop Companion response is too large.");
        }
        chunks.push(value);
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
      );
    } finally {
      reader.releaseLock();
    }
  }

  const parsed: unknown = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Desktop Companion response.");
  return parsed as Record<string, unknown>;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Transport client for a local Desktop Companion. The caller must provide a
 * real OS-backed credential store; this class never writes tokens to files,
 * browser storage, logs, or the model context.
 */
export function createDesktopCompanionClient(config: DesktopCompanionClientConfig): DesktopCompanionClient {
  const baseUrl = normalizeBaseUrl(config.apiBaseUrl);
  const fetcher = config.fetchImpl ?? fetch;
  const capabilities = new Set(config.allowedCapabilities);
  const allowedApplications = new Set(config.allowedApplications ?? []);
  const pollIntervalMs = Math.min(Math.max(500, config.pollIntervalMs ?? 2_000), 30_000);
  let activeController: AbortController | undefined;

  const request = async (path: string, token: string, init: RequestInit = {}): Promise<Response> => {
    return fetcher(baseUrl + path, {
      ...init,
      redirect: "error",
      ...(init.signal ? { signal: init.signal } : {}),
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: "Bearer " + token },
    });
  };

  const execute = async (action: DesktopAction, signal?: AbortSignal): Promise<unknown> => {
    assertDesktopAction(action);
    if (signal?.aborted) throw signal.reason ?? new Error("Desktop action aborted.");
    if (action.kind === "screen.capture") {
      if (!capabilities.has("screen:capture")) throw new Error("Local operator has not granted screen:capture.");
    } else if (action.kind === "app.launch") {
      if (!capabilities.has("app:launch")) throw new Error("Local operator has not granted app:launch.");
      if (!allowedApplications.has(action.applicationId)) throw new Error("Application is not allowlisted by the local operator.");
    } else if (!capabilities.has("input:control")) {
      throw new Error("Local operator has not granted input:control.");
    }
    const approved = await config.requestApproval(action, signal);
    if (!approved) throw new Error("Desktop action was denied by the local operator.");
    if (signal?.aborted) throw signal.reason ?? new Error("Desktop action aborted.");
    switch (action.kind) {
      case "screen.capture": {
        const capture = await config.driver.captureScreen(undefined, signal);
        if (capture.data.byteLength > 3.75 * 1024 * 1024) throw new Error("Screen capture exceeds the 5 MiB limit.");
        if (!Number.isInteger(capture.width) || !Number.isInteger(capture.height) || capture.width < 1 || capture.height < 1 || capture.width > 16384 || capture.height > 16384) {
          throw new Error("Desktop driver returned invalid screen dimensions.");
        }
        return { mimeType: capture.mimeType, dataBase64: Buffer.from(capture.data).toString("base64"), width: capture.width, height: capture.height };
      }
      case "app.launch":
        return config.driver.launchApplication(action.applicationId, action.args, signal);
      case "input.click":
        await config.driver.click({ x: action.x, y: action.y, button: action.button }, signal);
        return { ok: true };
      case "input.type":
        await config.driver.typeText(action.text, signal);
        return { ok: true };
      case "input.key":
        await config.driver.pressKey(action.key, signal);
        return { ok: true };
    }
  };

  const clearToken = async () => { await config.credentials.delete(); };

  // Retry only the completion transport request, never the native action.
  // The broker accepts an exact replay idempotently for a short receipt window.
  const postCompletion = async (
    path: string,
    token: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error("Desktop completion aborted.");
      try {
        const response = await request(path, token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal,
        });
        if (response.status < 500 || attempt === 2) return response;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        lastError = error;
        if (attempt === 2) throw error;
      }
      await abortableDelay(250 * (attempt + 1), signal ?? new AbortController().signal);
    }
    throw lastError instanceof Error ? lastError : new Error("Desktop completion transport failed.");
  };

  const pollOnce = async (signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted) return false;
    const token = await config.credentials.get();
    if (!token) throw new Error("Desktop Companion is not paired. Pair it with a Sofia API key first.");
    const polled = await request("/v1/desktop/companion/commands", token, { method: "GET", signal });
    if (polled.status === 401) {
      await clearToken();
      throw new Error("Desktop Companion pairing was revoked.");
    }
    if (!polled.ok) throw new Error("Desktop Companion poll failed with HTTP " + polled.status + ".");
    const payload = await responseJson(polled);
    if (payload.command === null || payload.command === undefined) return false;
    if (!payload.command || typeof payload.command !== "object" || Array.isArray(payload.command)) {
      throw new Error("Invalid Desktop Companion command envelope.");
    }
    const command = payload.command as Record<string, unknown>;
    if (typeof command.id !== "string" || !/^[0-9a-f-]{36}$/i.test(command.id) ||
        !Number.isFinite(command.createdAt) ||
        (command.leaseToken !== undefined && (typeof command.leaseToken !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(command.leaseToken)))) {
      throw new Error("Invalid Desktop Companion command metadata.");
    }
    assertDesktopAction(command.action as DesktopAction);
    const typedCommand = command as unknown as DesktopCompanionCommand;
    let outcome: DesktopCommandOutcome;
    const journal = config.journal;
    const needsJournal = typedCommand.action.kind !== "screen.capture" && journal !== undefined;
    if (needsJournal) {
      const previous = await journal!.get(typedCommand.id);
      if (previous?.status === "completed") {
        // The native action already finished; only replay its recorded response.
        outcome = previous.outcome;
      } else if (previous?.status === "started") {
        // It may have run before a crash. Never repeat a non-idempotent desktop action.
        outcome = { error: "Execution outcome is unknown after a previous Companion interruption. Check the desktop before manually retrying this action." };
      } else {
        let shouldExecute = true;
        try {
          await journal!.begin(typedCommand.id);
        } catch (beginError) {
          // Another local Companion process may have won the atomic create.
          // Re-read the journal and settle this delivery without repeating a side effect.
          const raced = await journal!.get(typedCommand.id);
          if (raced?.status === "completed") {
            outcome = raced.outcome;
            shouldExecute = false;
          } else if (raced?.status === "started") {
            outcome = { error: "Another Companion process has already claimed this command, or its previous execution was interrupted. Check the desktop before retrying." };
            shouldExecute = false;
          } else {
            throw beginError;
          }
        }
        if (shouldExecute) {
          try {
            outcome = { result: await execute(typedCommand.action, signal) };
          } catch (cause) {
            outcome = { error: cause instanceof Error ? cause.message : "Local desktop action failed." };
          }
          if (!signal?.aborted) {
            try { await journal!.complete(typedCommand.id, outcome); }
            catch {
              outcome = { error: "The desktop action may have run, but its result could not be safely recorded. Check the desktop before retrying." };
            }
          }
        }
      }
    } else {
      try { outcome = { result: await execute(typedCommand.action, signal) }; }
      catch (cause) { outcome = { error: cause instanceof Error ? cause.message : "Local desktop action failed." }; }
    }
    const error = outcome.error;
    const result = outcome.result;
    if (signal?.aborted) return false;
    const completed = await postCompletion(
      "/v1/desktop/companion/commands/" + encodeURIComponent(typedCommand.id) + "/complete",
      token,
      JSON.stringify({ ...(error ? { error: error.slice(0, 1000) } : { result }), ...(typedCommand.leaseToken ? { leaseToken: typedCommand.leaseToken } : {}) }),
      signal,
    );
    if (completed.status === 401) {
      await clearToken();
      throw new Error("Desktop Companion pairing was revoked.");
    }
    if (!completed.ok) throw new Error("Desktop Companion completion failed with HTTP " + completed.status + ".");
    return true;
  };

  return {
    async pair(apiKey: string) {
      if (!apiKey || apiKey.length > 4096) throw new Error("A valid Sofia API key is required for pairing.");
      const response = await fetcher(baseUrl + "/v1/desktop/companion/connect", {
        method: "POST",
        redirect: "error",
        headers: { authorization: "Bearer " + apiKey },
      });
      if (!response.ok) throw new Error("Desktop Companion pairing failed with HTTP " + response.status + ".");
      const payload = await responseJson(response);
      if (typeof payload.token !== "string" || payload.token.length < 40 || !Number.isFinite(payload.connectedAt)) {
        throw new Error("Invalid Desktop Companion pairing response.");
      }
      await config.credentials.set(payload.token);
      return { connectedAt: payload.connectedAt as number };
    },
    pollOnce,
    async start(signal?: AbortSignal) {
      if (activeController) throw new Error("Desktop Companion client is already running.");
      const controller = new AbortController();
      activeController = controller;
      const relayAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) controller.abort(signal.reason);
      else signal?.addEventListener("abort", relayAbort, { once: true });
      try {
        let retryDelayMs = pollIntervalMs;
        while (!controller.signal.aborted) {
          try {
            await pollOnce(controller.signal);
            // Any successful API round-trip resets outage backoff.
            retryDelayMs = pollIntervalMs;
            await abortableDelay(pollIntervalMs, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) break;
            if (error instanceof Error && error.message.includes("pairing was revoked")) throw error;
            // Avoid hammering a restarting or unreachable Cloud API. Keep retries
            // bounded and responsive to local stop/disconnect signals.
            await abortableDelay(retryDelayMs, controller.signal);
            retryDelayMs = Math.min(30_000, Math.max(pollIntervalMs, retryDelayMs * 2));
          }
        }
      } finally {
        signal?.removeEventListener("abort", relayAbort);
        if (activeController === controller) activeController = undefined;
      }
    },
    stop() {
      // Stopping the local process is not the same as revoking the paired device.
      // The restricted token remains in the OS credential store for a later restart.
      activeController?.abort(new Error("Desktop Companion stopped by local operator."));
    },
    async disconnect(apiKey: string) {
      if (!apiKey || apiKey.length > 4096) throw new Error("A Sofia API key is required to revoke this pairing.");
      activeController?.abort(new Error("Desktop Companion disconnected by local operator."));
      const response = await fetcher(baseUrl + "/v1/desktop/companion/disconnect", {
        method: "POST", redirect: "error", headers: { authorization: "Bearer " + apiKey },
      });
      if (!response.ok) throw new Error("Desktop Companion disconnect failed with HTTP " + response.status + ".");
      await clearToken();
    },
  };
}
