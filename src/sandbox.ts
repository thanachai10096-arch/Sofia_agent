export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  allowNetwork: boolean;
  workspaceRoot: string;
}

export interface Sandbox {
  readonly isolation: "policy" | "process" | "container";
  run(command: string, args: string[], limits: SandboxLimits, signal?: AbortSignal): Promise<{stdout:string;stderr:string;code:number}>;
}

/** Policy sandbox: enforces Sofia permissions but does not claim OS/container isolation. */
export class PolicySandbox implements Sandbox {
  readonly isolation = "policy" as const;
  constructor(private readonly runner: (command:string,args:string[],limits:SandboxLimits,signal?:AbortSignal)=>Promise<{stdout:string;stderr:string;code:number}>) {}
  run(command:string,args:string[],limits:SandboxLimits,signal?:AbortSignal){ return this.runner(command,args,limits,signal); }
}
