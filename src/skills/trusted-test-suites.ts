import type { SkillPackage } from "./platform.js";
import type { TrustedSkillTestSuite } from "./isolated-verifier.js";

const MAX_CONFIGURATION_BYTES = 512 * 1024;

/**
 * Loads operator-owned verification suites from deployment configuration.
 * Candidate artifacts cannot supply or override this source.
 */
export function loadTrustedSkillTestSuite(
  candidate: SkillPackage,
  raw = process.env.SOFIA_SKILL_TRUSTED_TEST_SUITES,
): TrustedSkillTestSuite | undefined {
  if (!raw) return undefined;
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIGURATION_BYTES) {
    throw new Error("Trusted skill test suite configuration exceeds the size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Trusted skill test suite configuration is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length > 128) {
    throw new Error("Trusted skill test suite configuration must be an array of at most 128 entries.");
  }
  const matches = parsed.filter((item) =>
    item && typeof item === "object" && !Array.isArray(item) &&
    (item as Record<string, unknown>).skillId === candidate.skill.id,
  );
  if (matches.length > 1) throw new Error("Multiple trusted test suites are configured for the same skill id.");
  if (matches.length === 0) return undefined;
  const match = matches[0] as Record<string, unknown>;
  if (typeof match.id !== "string" || typeof match.version !== "string" ||
      !match.files || typeof match.files !== "object" || Array.isArray(match.files) ||
      !Array.isArray(match.tests)) {
    throw new Error("Trusted skill test suite entry is malformed.");
  }
  return {
    id: match.id,
    version: match.version,
    files: match.files as Record<string, string>,
    tests: match.tests as string[],
  };
}
