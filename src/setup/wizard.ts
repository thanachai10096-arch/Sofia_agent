export type SetupMode = "hosted";
export type SetupStepId = "connection" | "credentials" | "verification";
export type SetupStepStatus = "pending" | "passed" | "needs_attention" | "not_tested";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  description: string;
  status: SetupStepStatus;
}

export interface HostedSetupConfig {
  version: 1;
  mode: "hosted";
  apiBaseUrl: string;
}

export interface SetupReadiness {
  readyToTry: boolean;
  steps: SetupStep[];
  notes: string[];
}

/**
 * Validate a Sofia API origin before storing it. API routes are rooted at "/",
 * so path prefixes are rejected rather than silently discarded by URL joining.
 * Remote HTTP is rejected; plain HTTP is permitted only for loopback development URLs.
 */
export function validateSofiaApiBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Enter the Sofia API base URL.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid absolute URL, such as https://sofia.example.com.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The Sofia API URL must use HTTPS (or HTTP for localhost development).");
  }
  if (url.username || url.password) {
    throw new Error("Do not include usernames or passwords in the Sofia API URL.");
  }
  if (url.search || url.hash) {
    throw new Error("The Sofia API URL must not contain a query string or fragment.");
  }
  if (url.pathname.replace(/\/+$/, "") !== "") {
    throw new Error("Use the Sofia API origin only, without a path prefix; API routes are rooted at '/'.");
  }

  const hostname = url.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("Remote Sofia API URLs must use HTTPS.");
  }

  return url.toString().replace(/\/+$/, "");
}

/** Produce a safe, honest checklist without making network calls. */
export function assessHostedSetup(input: {
  apiBaseUrl: string;
  hasApiKey: boolean;
  apiReachabilityChecked?: boolean;
}): SetupReadiness {
  const validUrl = validateSofiaApiBaseUrl(input.apiBaseUrl);
  const reachability = input.apiReachabilityChecked ? "passed" : "not_tested";
  const credentials = input.hasApiKey ? "passed" : "needs_attention";

  return {
    readyToTry: input.hasApiKey,
    steps: [
      {
        id: "connection",
        title: "Sofia API address",
        description: validUrl,
        status: "passed",
      },
      {
        id: "credentials",
        title: "API key",
        description: input.hasApiKey
          ? "SOFIA_API_KEY is available in this process environment."
          : "Set SOFIA_API_KEY in your shell or deployment secret manager. The wizard does not save API keys.",
        status: credentials,
      },
      {
        id: "verification",
        title: "Live connection",
        description: input.apiReachabilityChecked
          ? "A caller supplied a successful live check."
          : "Not tested yet. Setup does not send a billable or authenticated request automatically.",
        status: reachability,
      },
    ],
    notes: [
      "This CLI setup configures the hosted Sofia API endpoint; it does not configure a local model provider.",
      "The API key is never accepted as a wizard answer or written to the setup file.",
      "A valid URL and key do not prove that the server is reachable or that the key is authorized.",
    ],
  };
}

export function createHostedSetupConfig(apiBaseUrl: string): HostedSetupConfig {
  return {
    version: 1,
    mode: "hosted",
    apiBaseUrl: validateSofiaApiBaseUrl(apiBaseUrl),
  };
}


export interface HostedApiCheckResult {
  reachable: boolean;
  authenticated: boolean;
  service?: string;
  message: string;
}

/**
 * Explicit, non-billable connection check: public health plus authenticated
 * usage endpoint. It never submits an agent task or prints/sends the key
 * anywhere except the Authorization header to the configured HTTPS endpoint.
 */
export async function checkHostedSofiaApi(input: {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<HostedApiCheckResult> {
  const baseUrl = validateSofiaApiBaseUrl(input.apiBaseUrl);
  if (!input.apiKey.trim()) {
    return { reachable: false, authenticated: false, message: "SOFIA_API_KEY is not configured." };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? 8_000, 30_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let health: Response;
    try {
      health = await fetchImpl(new URL("/health", baseUrl), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      return {
        reachable: false,
        authenticated: false,
        message: controller.signal.aborted
          ? "Sofia API health check timed out."
          : "Could not reach the Sofia API health endpoint.",
      };
    }

    if (!health.ok) {
      return {
        reachable: true,
        authenticated: false,
        message: `Health endpoint returned HTTP ${health.status}.`,
      };
    }

    // A missing key should not hide whether the public health endpoint is reachable.
    // Do not make an authenticated request unless a non-empty key is available.
    if (!input.apiKey.trim()) {
      let service: string | undefined;
      try {
        const payload: unknown = await health.json();
        if (payload && typeof payload === "object" && "service" in payload && typeof payload.service === "string") {
          service = payload.service;
        }
      } catch {
        // HTTP health status is sufficient; optional metadata is intentionally ignored.
      }
      return {
        reachable: true,
        authenticated: false,
        ...(service ? { service } : {}),
        message: "Sofia API is reachable, but SOFIA_API_KEY is not configured.",
      };
    }

    let usage: Response;
    try {
      usage = await fetchImpl(new URL("/v1/usage", baseUrl), {
        method: "GET",
        headers: { authorization: `Bearer ${input.apiKey}`, accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      return {
        reachable: true,
        authenticated: false,
        message: controller.signal.aborted
          ? "Sofia API authentication check timed out."
          : "Health succeeded, but the authenticated API check could not complete.",
      };
    }

    if (usage.status === 401) {
      return { reachable: true, authenticated: false, message: "API reachable, but the API key was rejected (HTTP 401)." };
    }
    if (usage.status === 403) {
      return { reachable: true, authenticated: false, message: "API reachable, but this API key lacks permission (HTTP 403)." };
    }
    if (!usage.ok) {
      return { reachable: true, authenticated: false, message: `API reachable, but verification returned HTTP ${usage.status}.` };
    }

    let service: string | undefined;
    try {
      const payload: unknown = await health.json();
      if (payload && typeof payload === "object" && "service" in payload && typeof payload.service === "string") {
        service = payload.service;
      }
    } catch {
      // HTTP health status is sufficient; optional metadata is intentionally ignored.
    }
    return {
      reachable: true,
      authenticated: true,
      ...(service ? { service } : {}),
      message: "Sofia API is reachable and the API key was accepted.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
