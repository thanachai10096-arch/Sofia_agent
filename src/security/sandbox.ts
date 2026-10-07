import { spawn } from "node:child_process";
import path from "node:path";
export type SandboxOptions={workspaceRoot:string;command:string;args?:string[];timeoutMs?:number;network?:boolean};
export function sandboxCommand(o:SandboxOptions):Promise<{code:number;stdout:string;stderr:string}>{
 if(path.isAbsolute(o.command)||o.command.includes("..")) return Promise.reject(new Error("Unsafe sandbox command."));
 const args=o.args??[];
 return new Promise((resolve,reject)=>{
  const child=spawn(o.command,args,{cwd:o.workspaceRoot,shell:false,env:{PATH:process.env.PATH??""},stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr=""; const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Sandbox timeout"));},o.timeoutMs??30_000);
  child.stdout.on("data",d=>{stdout+=d.toString();if(stdout.length>2_000_000)child.kill("SIGKILL")});
  child.stderr.on("data",d=>{stderr+=d.toString();if(stderr.length>2_000_000)child.kill("SIGKILL")});
  child.on("error",e=>{clearTimeout(timer);reject(e)});
  child.on("close",code=>{clearTimeout(timer);resolve({code:code??-1,stdout,stderr})});
 });
}
