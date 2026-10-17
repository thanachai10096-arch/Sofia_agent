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
    const policyPattern = pattern.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
    return policyPath === policyPattern || policyPath.startsWith(policyPattern + "/") ||
      (!policyPattern.includes("/") && segments.includes(policyPattern));
  })) {
    throw new Error("Workspace path is blocked by security policy.");
  }
}

export function assessAction(action: Omit<SecurityAction, "actionHash" | "risk">, blockedPaths: readonly string[] = [], allowedHosts: readonly string[] = []): SecurityDecision {
  const hash = actionHash(action.runId, action.toolName, action.input, action.principalId);
  const pathValue = typeof action.input.path === "string" ? action.input.path : undefined;
  if (action.effects.includes("network") || action.effects.includes("browser")) {
    const url = typeof action.input.url === "string" ? action.input.url : undefined;
    if (url) {
      let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch { return { allowed:false,risk:"critical",requireApproval:true,reason:"Invalid network URL.",actionHash:hash }; }
      if (allowedHosts.length === 0 || !allowedHosts.some(allowed => host === allowed || host.endsWith("." + allowed))) return { allowed:false,risk:"critical",requireApproval:true,reason:"Network host is not allowlisted.",actionHash:hash };
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

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
      .replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]")
      .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|token|aws_secret_access_key)\s*[:=]\s*[^\s,}"']+/gi, "$1=[REDACTED]");
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
