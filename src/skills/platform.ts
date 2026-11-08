import type { SofiaSkill } from "../brain/skills.js";

export type SkillSource = "builtin" | "learned" | "project" | "custom" | "marketplace";

export interface SkillExecutableArtifact {
  format: "sofia-node-skill-v1";
  runtime: "node";
  entrypoint: string;
  files: Record<string, string>;
  tests: string[];
}

export interface SkillPackage {
  skill: SofiaSkill;
  source: SkillSource;
  version: string;
  publisher?: string;
  /** Optional executable payload; learned prose-only skills remain metadata, not code. */
  artifact?: SkillExecutableArtifact;
}

export interface SkillsPlatform {
  register(skill: SkillPackage): void;
  get(id: string): SkillPackage | undefined;
  list(source?: SkillSource): SkillPackage[];
  remove(id: string): boolean;
}

export class InMemorySkillsPlatform implements SkillsPlatform {
  private readonly skills = new Map<string, SkillPackage>();
  register(skill: SkillPackage): void { this.skills.set(skill.skill.id, skill); }
  get(id: string): SkillPackage | undefined { return this.skills.get(id); }
  list(source?: SkillSource): SkillPackage[] {
    return [...this.skills.values()].filter(x => !source || x.source === source);
  }
  remove(id: string): boolean { return this.skills.delete(id); }
}
