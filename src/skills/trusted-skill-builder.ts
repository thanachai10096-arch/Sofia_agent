import type { LearnedSkillCandidate } from "../brain/learning.js";
import type { SkillExecutableArtifact } from "./platform.js";

export interface ProjectFieldsSkillDsl {
  version: 1;
  operation: "project-fields";
  fields: string[];
}

const MAX_FIELDS = 32;
const MAX_FIELD_LENGTH = 128;
const RESERVED_FIELDS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Compile a deliberately small declarative skill language into a fixed,
 * reviewed interpreter. Candidate text is never copied into executable code.
 * Unsupported or absent plans remain metadata-only.
 */
export function buildTrustedSkillArtifact(
  candidate: LearnedSkillCandidate,
): SkillExecutableArtifact | undefined {
  const value: unknown = candidate.dsl;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "fields,operation,version" ||
      record.version !== 1 || record.operation !== "project-fields" ||
      !Array.isArray(record.fields) || record.fields.length === 0 ||
      record.fields.length > MAX_FIELDS ||
      !record.fields.every((field) =>
        typeof field === "string" &&
        field.length > 0 &&
        field.length <= MAX_FIELD_LENGTH &&
        /^[A-Za-z0-9_.-]+$/.test(field) &&
        !RESERVED_FIELDS.has(field),
      ) ||
      new Set(record.fields).size !== record.fields.length) {
    return undefined;
  }

  const fields = JSON.stringify(record.fields);
  const source = [
    `const fields = ${fields};`,
    "export function run(input, _context) {",
    '  if (input === null || typeof input !== "object" || Array.isArray(input)) {',
    '    throw new TypeError("project-fields expects a JSON object input");',
    "  }",
    "  const output = Object.create(null);",
    "  for (const field of fields) {",
    "    if (Object.hasOwn(input, field)) output[field] = input[field];",
    "  }",
    "  return output;",
    "}",
  ].join("\n");

  return {
    format: "sofia-node-skill-v1",
    runtime: "node",
    entrypoint: "index.mjs",
    files: { "index.mjs": source },
  };
}
