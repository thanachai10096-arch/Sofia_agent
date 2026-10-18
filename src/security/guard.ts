import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ToolEffect } from "./policy.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface SecurityAction {
  runId: string;
  principalId?: string | undefined;
  toolName: string;
  input: Record<string, unknown>;
  effects: readonly ToolEffect[];
  risk: RiskLevel;
  actionHash: string;
}

export interface SecurityDecision {
  allowed: boolean;
  risk: RiskLevel;
  requireApproval: boolean;
  reason?: string;
  actionHash: string;
}

const SECRET_PATH = /(^|[\\/])(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|crt)|id_(?:rsa|ed25519)|credentials(?:\.json)?|secrets?(?:\.json|\.ya?ml)?)$/i;
const SECRET_TOKEN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|authorization)\s*[:=]/i;
const INJECTION = /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|rules?)|reveal\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|instructions?)|disable\s+(?:security|safety|policy)|upload\s+(?:the\s+)?(?:\.env|credentials|secrets?)/i;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
}

export function actionHash(runId: string, toolName: string, input: Record<string, unknown>, principalId?: string): string {
  return createHash("sha256").update((principalId ?? "") + "\n" + runId + "\n" + toolName + "\n" + canonicalJson(input)).digest("hex");
}

export function riskFor(effects: readonly ToolEffect[], input: Record<string, unknown>): RiskLevel {
  if (effects.includes("destructive")) return "critical";
  const commandText = Array.isArray(input.args) ? input.args.join(" ") : String(input.command ?? "");
  if (/(?:^|\s)(?:reset|clean|push|force|rm|rmdir|del|format|shutdown|reboot)(?:\s|$)/i.test(commandText)) return "critical";
  if (effects.includes("shell")) return "high";
  if (effects.includes("network") || effects.includes("browser")) return "high";
  if (effects.includes("write")) return "medium";
  const text = canonicalJson(input);
  return SECRET_TOKEN.test(text) ? "high" : "low";
}

export function containsPromptInjection(value: unknown): boolean {
  if (typeof value === "string") return INJECTION.test(value);
  if (Array.isArray(value)) return value.some(containsPromptInjection);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsPromptInjection);
  return false;
}

function indexOfHttpPrefix(value: string, from: number): number {
  for (let i = from; i < value.length; i++) {
    const prefix = value.slice(i, i + 8).toLowerCase();
    if (prefix.startsWith("https://") || prefix.startsWith("http://")) return i;
  }
  return -1;
}

function collectHttpUrls(value: unknown, output: string[] = [], seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") {
    let cursor = 0;
    while (cursor < value.length) {
      const start = indexOfHttpPrefix(value, cursor);
      if (start < 0) break;
      let end = start;
      while (end < value.length) {
        const code = value.charCodeAt(end);
        if (code <= 0x20 || code === 34 || code === 39 || code === 60 || code === 62) break;
        end++;
      }
      let url = value.slice(start, end);
      while (url.length > 0 && "),.;".includes(url[url.length - 1]!)) url = url.slice(0, -1);
      if (url) output.push(url);
      cursor = Math.max(end, start + 1);
    }
  } else if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const item of items) collectHttpUrls(item, output, seen);
  }
  return output;
}

export function assertSafePath(inputPath: string, blockedPaths: readonly string[] = []): void {
  if (!inputPath || path.isAbsolute(inputPath) || inputPath.includes("\0")) throw new Error("Unsafe workspace path.");
  const normalized = path.normalize(inputPath);
  if (normalized === ".." || normalized.startsWith(".." + path.sep) || normalized.includes(path.sep + ".." + path.sep)) {
    throw new Error("Workspace path escapes the configured root.");
  }
  if (SECRET_PATH.test(normalized)) throw new Error("Access to credential/secret files is blocked.");
  const policyPath = normalized.replace(/\\/g, "/").toLowerCase();
  const segments = policyPath.split("/");
  if (blockedPaths.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, "/");
    let patternEnd = normalizedPattern.length;
    while (patternEnd > 0 && normalizedPattern[patternEnd - 1] === "/") patternEnd--;
    const policyPattern = normalizedPattern.slice(0, patternEnd).toLowerCase();
    if (!policyPattern) return false;
    return policyPath === policyPattern || policyPath.startsWith(policyPattern + "/") ||
      (!policyPattern.includes("/") && segments.includes(policyPattern));
  })) {
    throw new Error("Workspace path is blocked by security policy.");
  }
}

function isGitNetworkCommand(input: Record<string, unknown>): boolean {
  const commandText = [input.command, input.args]
    .filter((value) => value !== undefined)
    .map((value) => Array.isArray(value) ? value.map(String).join(" ") : String(value))
    .join(" ")
    .toLowerCase();
  const words = commandText.split(/[^a-z-]+/).filter(Boolean);
  return words.some((word) => ["clone", "fetch", "pull", "push", "ls-remote", "submodule"].includes(word));
}

export function assessAction(action: Omit<SecurityAction, "actionHash" | "risk">, blockedPaths: readonly string[] = [], allowedHosts: readonly string[] = []): SecurityDecision {
  const hash = actionHash(action.runId, action.toolName, action.input, action.principalId);
  const pathValue = typeof action.input.path === "string" ? action.input.path : undefined;
  if (action.effects.includes("network") || action.effects.includes("browser")) {
    const explicitUrl = typeof action.input.url === "string" ? action.input.url : undefined;
    const discoveredUrls = collectHttpUrls(action.input).filter((url) => url !== explicitUrl);
    const urls = [...(explicitUrl ? [explicitUrl] : []), ...discoveredUrls];
    const opaqueGitNetworkOperation = action.toolName === "git.run" && isGitNetworkCommand(action.input);
    if (urls.length === 0 && action.toolName !== "terminal.run" && !(action.toolName === "git.run" && !opaqueGitNetworkOperation)) {
      return { allowed: false, risk: "critical", requireApproval: true, reason: "Network actions must expose an explicit HTTP(S) URL for allowlist enforcement.", actionHash: hash };
    }
    for (const url of urls) {
      let host = "";
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
        host = parsed.hostname.toLowerCase();
      } catch {
        return { allowed: false, risk: "critical", requireApproval: true, reason: "Invalid network URL.", actionHash: hash };
      }
      if (allowedHosts.length === 0 || !allowedHosts.some((allowed) => {
        const normalizedAllowed = allowed.toLowerCase().replace(/\.$/, "");
        return host === normalizedAllowed || host.endsWith("." + normalizedAllowed);
      })) {
        return { allowed: false, risk: "critical", requireApproval: true, reason: "Network host is not allowlisted.", actionHash: hash };
      }
    }
  }
  const patchPaths = Array.isArray(action.input.operations)
    ? action.input.operations.map((op) => (op && typeof op === "object" ? (op as { path?: unknown }).path : undefined)).filter((p): p is string => typeof p === "string")
    : [];
  for (const candidate of [...(pathValue ? [pathValue] : []), ...patchPaths]) assertSafePath(candidate, blockedPaths);

  // Treat command/URL/query text as untrusted control input. Content being written is
  // deliberately excluded so legitimate source code/comments can contain these phrases.
  const controlFields = ["command", "url", "query", "args"];
  const controlText = controlFields.map(k => action.input[k]).filter(v => v !== undefined);
  if (containsPromptInjection(controlText)) {
    return { allowed: false, risk: "critical", requireApproval: true, reason: "Suspicious instruction pattern in tool parameters.", actionHash: hash };
  }

  const risk = riskFor(action.effects, action.input);
  const requireApproval = risk === "medium" || risk === "high" || risk === "critical";
  return { allowed: true, risk, requireApproval, actionHash: hash };
}

function redactPrivateKeyBlocks(value: string): string {
  const prefixes = new Set(["", "RSA ", "EC ", "OPENSSH ", "DSA ", "ENCRYPTED "]);
  const header = "PRIVATE KEY-----";
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const begin = value.indexOf("-----BEGIN ", cursor);
    if (begin < 0) return result + value.slice(cursor);
    result += value.slice(cursor, begin);
    const labelStart = begin + "-----BEGIN ".length;
    const headerEnd = value.indexOf(header, labelStart);
    if (headerEnd < 0) {
      result += value.slice(begin, labelStart);
      cursor = labelStart;
      continue;
    }
    const prefix = value.slice(labelStart, headerEnd);
    if (!prefixes.has(prefix)) {
      result += value.slice(begin, labelStart);
      cursor = labelStart;
      continue;
    }
    const endMarker = "-----END " + prefix + "PRIVATE KEY-----";
    const end = value.indexOf(endMarker, headerEnd + header.length);
    if (end < 0) {
      result += value.slice(begin, labelStart);
      cursor = labelStart;
      continue;
    }
    result += "[REDACTED PRIVATE KEY]";
    cursor = end + endMarker.length;
  }
  return result;
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPrivateKeyBlocks(value)
      .replace(/\b(?:xox[baprs]-[A-Za-z0-9-]{10,})\b/gi, "[REDACTED]")
      .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g, "[REDACTED]")
      .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|authorization|token|secret[_-]?key|session[_-]?token|aws_secret_access_key)\s*[:=]\s*[^\s,}"']+/gi, "$1=[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = /(?:token|secret|password|credential|private.?key|authorization|api.?key)/i.test(key) ? "[REDACTED]" : redactSecrets(item);
    }
    return result;
  }
  return value;
}

export function safeAuditAction(action: SecurityAction): SecurityAction {
  return { ...action, input: redactSecrets(action.input) as Record<string, unknown> };
}

export function newSecurityEventId(): string { return randomUUID(); }
