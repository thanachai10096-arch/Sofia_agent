import type { AdvancedSkillHandler } from "./advanced-skill-runtime.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";
import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { assertSafePath, assessAction, type SecurityAction, type SecurityDecision } from "../security/guard.js";
import type { ToolEffect } from "../security/policy.js";
import { fenceUntrustedOutput, scanUntrustedText } from "../security/untrusted.js";

type InputRecord = Record<string, unknown>;
const TOOL_EFFECTS: readonly ToolEffect[] = ["read", "write", "shell", "network", "destructive", "browser"];

function record(input: unknown): InputRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Skill input must be an object.");
  return input as InputRecord;
}
function requiredText(input: InputRecord, key: string, max = 8_000): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Skill input ${key} must be a non-empty string.`);
  if (value.length > max) throw new RangeError(`Skill input ${key} exceeds ${max} characters.`);
  return value.trim();
}
function textList(value: unknown, key: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim() || item.length > 500)) {
    throw new TypeError(`Skill input ${key} must be an array of at most ${max} non-empty strings.`);
  }
  return value.map(item => (item as string).trim());
}
function effectList(value: unknown): ToolEffect[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || !TOOL_EFFECTS.includes(item as ToolEffect))) {
    throw new TypeError("Skill input effects must be a non-empty list of known tool effects.");
  }
  return [...new Set(value as ToolEffect[])];
}

/** Evaluates an action using Sofia's existing security guard; this is advisory, not an authorization bypass. */
export const permissionPolicyEvaluator: AdvancedSkillHandler = (input) => {
  const value = record(input);
  const actionInput = value.input;
  if (!actionInput || typeof actionInput !== "object" || Array.isArray(actionInput)) {
    throw new TypeError("Skill input input must be an object.");
  }
  const principalId = typeof value.principalId === "string" ? value.principalId : undefined;
  const action: Omit<SecurityAction, "actionHash" | "risk"> = {
    runId: requiredText(value, "runId", 120),
    ...(principalId ? { principalId } : {}),
    toolName: requiredText(value, "toolName", 160),
    input: actionInput as Record<string, unknown>,
    effects: effectList(value.effects),
  };
  const blockedPaths = value.blockedPaths === undefined ? [] : textList(value.blockedPaths, "blockedPaths");
  const allowedHosts = value.allowedHosts === undefined ? [] : textList(value.allowedHosts, "allowedHosts");
  return assessAction(action, blockedPaths, allowedHosts) as SecurityDecision;
};

/** Computes the minimum capability set and lists every requested capability that is unavailable. */
export const leastPrivilegePlanner: AdvancedSkillHandler = (input) => {
  const value = record(input);
  const required = [...new Set(textList(value.requiredCapabilities, "requiredCapabilities"))];
  const available = new Set(textList(value.availableCapabilities, "availableCapabilities"));
  const granted = required.filter(capability => available.has(capability));
  const denied = required.filter(capability => !available.has(capability));
  return {
    granted,
    denied,
    sufficient: denied.length === 0,
    principle: "grant-only-requested-capabilities",
  };
};

/** Scans untrusted text for instruction-like signals; detection is heuristic, not a safety proof. */
export const promptInjectionDetector: AdvancedSkillHandler = (input) => {
  const value = record(input);
  const content = requiredText(value, "content");
  return { ...scanUntrustedText(content), contentLength: content.length };
};

/** Wraps tool output in Sofia's established untrusted-data fence and truncation policy. */
export const untrustedOutputFencer: AdvancedSkillHandler = (input) => {
  const value = record(input);
  const tool = requiredText(value, "tool", 160);
  const output = requiredText(value, "output", 1_000_000);
  const maxChars = value.maxChars;
  if (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || (maxChars as number) < 1 || (maxChars as number) > 100_000)) {
    throw new RangeError("maxChars must be an integer from 1 to 100000.");
  }
  return fenceUntrustedOutput(tool, output, maxChars === undefined ? {} : { maxChars: maxChars as number });
};

/** Validates lexical path safety only; actual filesystem access must still use WorkspaceRuntime. */
export const pathTraversalGuard: AdvancedSkillHandler = (input) => {
  const value = record(input);
  const path = requiredText(value, "path", 1_000);
  const blockedPaths = value.blockedPaths === undefined ? [] : textList(value.blockedPaths, "blockedPaths");
  try {
    assertSafePath(path, blockedPaths);
    return { safe: true, reason: "Path passed lexical validation." };
  } catch (error) {
    return {
      safe: false,
      reason: error instanceof Error ? error.message.slice(0, 240) : "Path rejected by safety policy.",
    };
  }
};

const SECURITY_SKILLS: ReadonlyArray<{ id: string; handler: AdvancedSkillHandler }> = [
  { id: "security.01", handler: permissionPolicyEvaluator },
  { id: "security.02", handler: leastPrivilegePlanner },
  { id: "security.04", handler: promptInjectionDetector },
  { id: "security.05", handler: untrustedOutputFencer },
  { id: "security.06", handler: pathTraversalGuard },
];

export function registerVerifiedSecuritySkills(registry: AdvancedSkillRegistry): string[] {
  const registered: string[] = [];
  for (const item of SECURITY_SKILLS) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}
