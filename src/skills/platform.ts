import type { SofiaSkill } from "../brain/skills.js";

export type SkillSource = "builtin" | "learned" | "project" | "custom" | "marketplace";

export interface SkillPackage {
  skill: SofiaSkill;
  source: SkillSource;
  version: string;
  publisher?: string;
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
