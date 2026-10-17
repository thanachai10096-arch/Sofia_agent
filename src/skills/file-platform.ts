import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SofiaSkill } from "../brain/skills.js";
import type { SkillPackage, SkillsPlatform, SkillSource } from "./platform.js";

interface PersistedSkills {
  schemaVersion: 1;
  skills: SkillPackage[];
}

const SOURCES = new Set<SkillSource>(["builtin", "learned", "project", "custom", "marketplace"]);
const CATEGORIES = new Set(["syntax_error", "type_error", "runtime_error", "dependency_error", "permission_error", "network_error", "tool_error", "wrong_assumption", "incomplete_solution", "environment_error", "unknown"]);
const STRATEGIES = new Set(["initial", "inspect-evidence", "fix-implementation", "fix-environment", "alternative-tool"]);
const VERIFICATION = new Set(["typecheck", "test", "build"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function stringArray(value: unknown, allowed?: Set<string>): value is string[] {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item) && (!allowed || allowed.has(item)));
}
function validateSkillPackage(value: unknown): SkillPackage {
  if (!record(value) || !record(value.skill)) throw new Error("Invalid persisted skill package");
  const skill = value.skill;
  if (!nonEmptyString(skill.id, 160) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(skill.id)) throw new Error("Invalid skill id in skills store");
  if (!nonEmptyString(skill.name, 200) || !nonEmptyString(skill.description, 2_000)) throw new Error("Invalid skill name or description");
  if (!stringArray(skill.triggers) || !stringArray(skill.categories, CATEGORIES) || !STRATEGIES.has(String(skill.strategy)) ||
      !stringArray(skill.procedure) || !stringArray(skill.verification, VERIFICATION)) {
    throw new Error("Invalid skill definition in skills store");
  }
  if (typeof value.source !== "string" || !SOURCES.has(value.source as SkillSource)) throw new Error("Invalid skill source in skills store");
  if (!nonEmptyString(value.version, 100)) throw new Error("Invalid skill version in skills store");
  if (value.publisher !== undefined && !nonEmptyString(value.publisher, 200)) throw new Error("Invalid skill publisher in skills store");
  return JSON.parse(JSON.stringify(value)) as SkillPackage;
}

/**
 * File-backed implementation of the existing SkillsPlatform contract.
 * This store is intended for a single active process; it is not a distributed registry.
 * Persisted skill metadata is never executed by this class.
 */
export class FileSkillsPlatform implements SkillsPlatform {
  private readonly skills = new Map<string, SkillPackage>();
  private readonly file: string;

  constructor(file: string) {
    if (!path.isAbsolute(file)) throw new Error("Skills store path must be absolute");
    this.file = file;
    if (!existsSync(file)) return;
    if (lstatSync(file).isSymbolicLink()) throw new Error("Skills store must not be a symbolic link");
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!record(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.skills)) {
      throw new Error("Unsupported or corrupt skills store format");
    }
    for (const raw of parsed.skills) {
      const item = validateSkillPackage(raw);
      if (this.skills.has(item.skill.id)) throw new Error("Duplicate skill id in skills store: " + item.skill.id);
      this.skills.set(item.skill.id, item);
    }
  }

  register(skill: SkillPackage): void {
    const safe = validateSkillPackage(skill);
    const previous = this.skills.get(safe.skill.id);
    this.skills.set(safe.skill.id, safe);
    try { this.persist(); }
    catch (error) {
      if (previous) this.skills.set(safe.skill.id, previous);
      else this.skills.delete(safe.skill.id);
      throw error;
    }
  }

  get(id: string): SkillPackage | undefined {
    const value = this.skills.get(id);
    return value ? JSON.parse(JSON.stringify(value)) as SkillPackage : undefined;
  }

  list(source?: SkillSource): SkillPackage[] {
    return [...this.skills.values()]
      .filter((item) => !source || item.source === source)
      .sort((a, b) => a.skill.id.localeCompare(b.skill.id))
      .map((item) => JSON.parse(JSON.stringify(item)) as SkillPackage);
  }

  remove(id: string): boolean {
    const previous = this.skills.get(id);
    if (!previous) return false;
    this.skills.delete(id);
    try { this.persist(); }
    catch (error) {
      this.skills.set(id, previous);
      throw error;
    }
    return true;
  }

  private persist(): void {
    const directory = path.dirname(this.file);
    mkdirSync(directory, { recursive: true });
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) {
      throw new Error("Skills store must not be a symbolic link");
    }
    const payload: PersistedSkills = {
      schemaVersion: 1,
      skills: [...this.skills.values()].sort((a, b) => a.skill.id.localeCompare(b.skill.id)),
    };
    const temporary = this.file + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
