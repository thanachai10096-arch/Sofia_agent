export interface ExecutionPolicy {
  allowTools: boolean; allowNetwork: boolean; allowShell: boolean; allowFileWrite: boolean;
  maxSteps: number; maxToolCallsPerStep: number;
}
export const defaultPolicy: ExecutionPolicy = { allowTools:true, allowNetwork:false, allowShell:false, allowFileWrite:true, maxSteps:12, maxToolCallsPerStep:4 };
export function assertSafeStep(policy: ExecutionPolicy, step:number):void { if(step>policy.maxSteps) throw new Error("Agent step limit exceeded"); }
export function assertToolAllowed(policy:ExecutionPolicy,name:string):void {
  if(!policy.allowTools) throw new Error("Tool execution is disabled by policy.");
  if(name==="terminal.run"&&!policy.allowShell) throw new Error("Shell execution is disabled by policy.");
  if(name==="workspace.write_file"&&!policy.allowFileWrite) throw new Error("File writes are disabled by policy.");
}