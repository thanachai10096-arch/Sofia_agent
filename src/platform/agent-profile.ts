export interface AgentProfile {
  id:string; name:string; description:string; systemInstructions?:string;
  allowedTools:string[]; defaultSkillIds:string[]; policyOverrides?:Record<string,boolean>;
}
export interface AgentTemplate {
  id:string; profileId:string; name:string; description:string; taskHints:string[]; skillIds:string[];
}
export class AgentProfileRegistry {
  private readonly profiles=new Map<string,AgentProfile>();
  private readonly templates=new Map<string,AgentTemplate>();
  registerProfile(profile:AgentProfile):void{this.profiles.set(profile.id,profile);}
  getProfile(id:string):AgentProfile|undefined{return this.profiles.get(id);}
  listProfiles():AgentProfile[]{return[...this.profiles.values()];}
  registerTemplate(template:AgentTemplate):void{
    if(!this.profiles.has(template.profileId))throw new Error(`Unknown profile: ${template.profileId}`);
    this.templates.set(template.id,template);
  }
  getTemplate(id:string):AgentTemplate|undefined{return this.templates.get(id);}
  listTemplates():AgentTemplate[]{return[...this.templates.values()];}
}
