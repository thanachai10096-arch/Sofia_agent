import { readFileSync } from "node:fs";
import path from "node:path";
import type { ModelRoute } from "./types.js";

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
}

type Environment = Record<string, string | undefined>;

function readLocalEnv(filePath: string): Environment {
  try {
    const source = readFileSync(filePath, "utf8");
    const result: Environment = {};
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2]!.trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); }
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }
      result[match[1]!] = value;
    }
    return result;
  } catch { return {}; }
}

function numberEnv(env: Environment, name: string, fallback: number) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const ROUTE_DEFINITIONS = [
  ["fast", ["fast"], 1, 1, 5],
  ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
  ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
  ["vision", ["vision", "reasoning"], 3, 3, 8],
] as const;

function validateBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("SOFIA_MODEL_BASE_URL must be a valid HTTP(S) URL."); }
  const localHttp = parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SOFIA_MODEL_BASE_URL must use HTTPS (HTTP is allowed only for localhost) and must not contain credentials, query, or fragment.");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.origin + pathname + "/";
}

/**
 * Configure any OpenAI-compatible chat-completions endpoint with:
 * SOFIA_MODEL_BASE_URL, SOFIA_MODEL_API_KEY, and SOFIA_MODEL.
 * These may be supplied by the process environment or a local .env file.
 * When absent, preserve the legacy direct Gemini setup.
 */
export function loadModelConfigFromEnv(env: Environment = process.env, localEnvPath = path.resolve(process.cwd(), ".env")): SofiaModelConfig {
  const fileEnv = readLocalEnv(localEnvPath);
  // Explicit process environment always wins over local files.
  const merged: Environment = { ...fileEnv, ...env };
  const genericValues = [
    merged.SOFIA_MODEL_BASE_URL?.trim(),
    merged.SOFIA_MODEL_API_KEY?.trim(),
    merged.SOFIA_MODEL?.trim(),
  ];
  const genericConfigured = genericValues.some(Boolean);
  let baseUrl: string;
  let apiKey: string;
  let defaultModel: string;
  let generic = false;

  if (genericConfigured) {
    if (genericValues.some((value) => !value)) {
      throw new Error("Set all three variables together: SOFIA_MODEL_BASE_URL, SOFIA_MODEL_API_KEY, and SOFIA_MODEL.");
    }
    baseUrl = validateBaseUrl(genericValues[0]!);
    apiKey = genericValues[1]!;
    defaultModel = genericValues[2]!;
    generic = true;
  } else {
    apiKey = merged.GEMINI_API_KEY?.trim() || merged.Gemini_API_Key?.trim() || "";
    if (!apiKey) {
      throw new Error("Configure SOFIA_MODEL_BASE_URL + SOFIA_MODEL_API_KEY + SOFIA_MODEL, or set GEMINI_API_KEY for the legacy Gemini default.");
    }
    baseUrl = GEMINI_BASE_URL;
    defaultModel = merged.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  }

  const providerPrefix = generic ? (merged.SOFIA_MODEL_PROVIDER?.trim() || "custom").toUpperCase() : "GEMINI";
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(providerPrefix)) {
    throw new Error("SOFIA_MODEL_PROVIDER must contain only letters, numbers, and underscores and start with a letter.");
  }

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};
  for (const [id, capabilities, cost, latency, quality] of ROUTE_DEFINITIONS) {
    const routeSpecificModel = generic
      ? merged[`SOFIA_${id.toUpperCase()}_MODEL`]?.trim()
      : merged[`GEMINI_${id.toUpperCase()}_MODEL`]?.trim();
    routes.push({
      id,
      providerId: id,
      capabilities: [...capabilities] as import("./types.js").ModelCapability[],
      costWeight: numberEnv(merged, `SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(merged, `SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(merged, `SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    });
    providers[id] = { baseUrl, apiKey, model: routeSpecificModel || defaultModel };
  }
  return { routes, providers };
}
