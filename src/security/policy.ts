export interface ExecutionPolicy {
  allowTools:boolean; allowNetwork:boolean; allowShell:boolean; allowFileWrite:boolean;
  maxSteps:number; maxToolCallsPerStep:number;
}
export const defaultPolicy:ExecutionPolicy={allowTools:true,allowNetwork:false,allowShell:false,allowFileWrite:true,maxSteps:12,maxToolCallsPerStep:4};
export function loadExecutionPolicyFromEnv():ExecutionPolicy{
  const bool=(name:string,fallback:boolean)=>process.env[name]===undefined?fallback:process.env[name]==="true";
  const num=(name:string,fallback:number)=>{const n=Number(process.env[name]);return Number.isFinite(n)&&n>0?n:fallback;};
  return {...defaultPolicy,allowTools:bool("SOFIA_ALLOW_TOOLS",defaultPolicy.allowTools),allowNetwork:bool("SOFIA_ALLOW_NETWORK",defaultPolicy.allowNetwork),allowShell:bool("SOFIA_ALLOW_SHELL",defaultPolicy.allowShell),allowFileWrite:bool("SOFIA_ALLOW_FILE_WRITE",defaultPolicy.allowFileWrite),maxSteps:Math.min(num("SOFIA_MAX_STEPS",defaultPolicy.maxSteps),50),maxToolCallsPerStep:Math.min(num("SOFIA_MAX_TOOL_CALLS_PER_STEP",defaultPolicy.maxToolCallsPerStep),16)};
}
export function assertSafeStep(policy:ExecutionPolicy,step:number):void{if(step>policy.maxSteps)throw new Error("Agent step limit exceeded");}
export function assertToolAllowed(policy:ExecutionPolicy,name:string):void{
  if(!policy.allowTools)throw new Error("Tool execution is disabled by policy.");
  if(name==="terminal.run"&&!policy.allowShell)throw new Error("Shell execution is disabled by policy.");
  if(name==="workspace.write_file"&&!policy.allowFileWrite)throw new Error("File writes are disabled by policy.");
}