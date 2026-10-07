import { spawn } from "node:child_process";

export interface SandboxLimits { timeoutMs:number; maxOutputBytes:number; allowNetwork:boolean; workspaceRoot:string; }
export interface Sandbox { readonly isolation:"policy"|"process"|"container"; run(command:string,args:string[],limits:SandboxLimits,signal?:AbortSignal):Promise<{stdout:string;stderr:string;code:number}>; }

export class PolicySandbox implements Sandbox {
  readonly isolation="policy" as const;
  constructor(private readonly runner:(command:string,args:string[],limits:SandboxLimits,signal?:AbortSignal)=>Promise<{stdout:string;stderr:string;code:number}>){}
  run(command:string,args:string[],limits:SandboxLimits,signal?:AbortSignal){return this.runner(command,args,limits,signal);}
}

/** Process isolation with bounded lifetime/output. It is not a container and does not claim kernel-level filesystem/network isolation. */
export class ProcessSandbox implements Sandbox {
  readonly isolation="process" as const;
  async run(command:string,args:string[],limits:SandboxLimits,signal?:AbortSignal){
    const child=spawn(command,args,{cwd:limits.workspaceRoot,shell:false,env:process.env});
    let stdout="",stderr="";
    const append=(current:string,value:Buffer|string)=>{const next=current+value.toString();return next.length>limits.maxOutputBytes?next.slice(0,limits.maxOutputBytes):next;};
    const onAbort=()=>child.kill("SIGTERM");
    if(signal)signal.addEventListener("abort",onAbort,{once:true});
    const timer=setTimeout(()=>child.kill("SIGTERM"),Math.max(1,limits.timeoutMs));
    const result=await new Promise<{stdout:string;stderr:string;code:number}>((resolve)=>{
      child.stdout?.on("data",d=>{stdout=append(stdout,d);});
      child.stderr?.on("data",d=>{stderr=append(stderr,d);});
      child.on("error",e=>resolve({stdout,stderr:stderr||String(e),code:1}));
      child.on("close",code=>resolve({stdout,stderr,code:code??1}));
    });
    clearTimeout(timer); if(signal)signal.removeEventListener("abort",onAbort); return result;
  }
}
