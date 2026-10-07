import type { RiskLevel } from "./guard.js";

export type ToolEffect = "read" | "write" | "shell" | "network" | "destructive" | "browser";
export interface ToolPermission { allow?: boolean; requireApproval?: boolean; maxRisk?: RiskLevel; }
export interface ExecutionPolicy {
  allowTools:boolean; allowNetwork:boolean; allowShell:boolean; allowFileWrite:boolean; allowBrowser:boolean;
  allowDestructive:boolean; maxRisk:RiskLevel; maxSteps:number; maxToolCallsPerStep:number;
  blockedPaths:string[]; allowedHosts:string[]; permissions:Record<string,ToolPermission>;
}
export const defaultPolicy:ExecutionPolicy={
  allowTools:true,allowNetwork:false,allowShell:false,allowFileWrite:true,allowBrowser:false,
  allowDestructive:false,maxRisk:"high",maxSteps:12,maxToolCallsPerStep:4,
  blockedPaths:[".env",".git","node_modules",".sofia/secrets"],allowedHosts:[],permissions:{},
};
const riskRank:Record<RiskLevel,number>={low:0,medium:1,high:2,critical:3};
export function loadExecutionPolicyFromEnv():ExecutionPolicy{
  const bool=(name:string,fallback:boolean)=>process.env[name]===undefined?fallback:process.env[name]==="true";
  const num=(name:string,fallback:number)=>{const n=Number(process.env[name]);return Number.isFinite(n)&&n>0?n:fallback;};
  const raw=process.env.SOFIA_MAX_RISK;
  const maxRisk:RiskLevel=raw==="low"||raw==="medium"||raw==="high"||raw==="critical"?raw:defaultPolicy.maxRisk;
  const allowedHosts=process.env.SOFIA_ALLOWED_HOSTS?process.env.SOFIA_ALLOWED_HOSTS.split(",").map(x=>x.trim().toLowerCase()).filter(Boolean):defaultPolicy.allowedHosts;\n  const blockedPaths=process.env.SOFIA_BLOCKED_PATHS?process.env.SOFIA_BLOCKED_PATHS.split(",").map(x=>x.trim()).filter(Boolean):defaultPolicy.blockedPaths;
  return {...defaultPolicy,allowTools:bool("SOFIA_ALLOW_TOOLS",defaultPolicy.allowTools),allowNetwork:bool("SOFIA_ALLOW_NETWORK",defaultPolicy.allowNetwork),allowShell:bool("SOFIA_ALLOW_SHELL",defaultPolicy.allowShell),allowFileWrite:bool("SOFIA_ALLOW_FILE_WRITE",defaultPolicy.allowFileWrite),allowBrowser:bool("SOFIA_ALLOW_BROWSER",defaultPolicy.allowBrowser),allowDestructive:bool("SOFIA_ALLOW_DESTRUCTIVE",defaultPolicy.allowDestructive),maxRisk,blockedPaths,maxSteps:Math.min(num("SOFIA_MAX_STEPS",defaultPolicy.maxSteps),50),maxToolCallsPerStep:Math.min(num("SOFIA_MAX_TOOL_CALLS_PER_STEP",defaultPolicy.maxToolCallsPerStep),16),allowedHosts,permissions:defaultPolicy.permissions};
}
export function assertSafeStep(policy:ExecutionPolicy,step:number):void{if(step>policy.maxSteps)throw new Error("Agent step limit exceeded");}
export function toolPermission(policy:ExecutionPolicy,name:string,effects:readonly ToolEffect[]):ToolPermission{
  const override=policy.permissions[name]??{};
  if(override.allow===false)return override;
  if(effects.includes("destructive")&&!policy.allowDestructive)return{allow:false};
  if(effects.includes("shell")&&!policy.allowShell)return{allow:false};
  if(effects.includes("write")&&!policy.allowFileWrite)return{allow:false};
  if(effects.includes("network")&&!policy.allowNetwork)return{allow:false};
  if(effects.includes("browser")&&!policy.allowBrowser)return{allow:false};
  return override;
}
export function assertToolAllowed(policy:ExecutionPolicy,name:string,effects:readonly ToolEffect[]=[]):void{
  if(!policy.allowTools)throw new Error("Tool execution is disabled by policy.");
  if(toolPermission(policy,name,effects).allow===false)throw new Error(`Tool execution is disabled by policy: ${name}`);
}
export { riskRank };
