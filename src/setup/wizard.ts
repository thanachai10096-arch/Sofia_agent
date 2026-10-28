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
 * Validate a Sofia API base URL before storing it. Remote HTTP is rejected;
 * plain HTTP is permitted only for loopback development URLs.
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
