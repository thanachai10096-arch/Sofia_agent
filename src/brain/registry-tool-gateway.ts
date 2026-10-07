import { createHash, randomUUID } from "node:crypto";
import type { ExecutionPolicy, ToolEffect } from "../security/policy.js";
import { toolPermission, riskRank } from "../security/policy.js";
import { assessAction, type RiskLevel } from "../security/guard.js";
import type { AgentDependencies } from "../agent/types.js";
import type { ApprovalHandler } from "../agent/approval.js";
import type { SecurityAuditSink } from "../security/audit.js";
import { SecurityController } from "../security/controller.js";
import type { ToolGateway, ToolExecutionContext, ToolResult, WorkspaceSnapshot, WorkspaceCheckpoint, ToolCall } from "./types.js";
import { RuntimeCheckpointManager, type CheckpointManager } from "./checkpoint.js";

function digest(value:string){return createHash("sha256").update(value).digest("hex");}
function classifyEffects(name:string):ToolEffect[]{
  if(name.startsWith("browser."))return["browser","network"];
  if(name==="workspace.read_file"||name==="workspace.list_files"||name==="workspace.search"||name==="git.diff"||name==="project.verify")return["read"];
  if(name==="workspace.write_file"||name==="workspace.apply_patch")return["write"];
  if(name==="terminal.run")return["shell"];
  if(name==="git.run")return["read","write"];
  return["read"];
}
interface SnapshotRecord{id:string;revision:string;files:string[];fingerprints:Record<string,string>}

export class RegistryToolGateway implements ToolGateway {
  private readonly snapshots=new Map<string,SnapshotRecord>();
  private readonly checkpoints:CheckpointManager;
  constructor(
    private readonly dependencies:Pick<AgentDependencies,"runtime"|"tools">,
    private readonly policy:ExecutionPolicy,
    private readonly approval?:ApprovalHandler,
    checkpoints?:CheckpointManager,
    private readonly security:SecurityController=new SecurityController(),
    private readonly audit?:SecurityAuditSink,
  ){this.checkpoints=checkpoints??new RuntimeCheckpointManager(dependencies.runtime);}
  describe(name:string){const tool=this.dependencies.tools.get(name);if(!tool)return undefined;return{effects:classifyEffects(name)};}

  async execute(call:ToolCall,context:ToolExecutionContext):Promise<ToolResult>{
    context.signal.throwIfAborted();
    this.security.assertRunning();
    const descriptor=this.describe(call.tool);
    const evidenceId=randomUUID();
    if(!descriptor)return{ok:false,data:null,evidenceId,error:{category:"tool_error",message:`Unknown tool: ${call.tool}`}};
    if(!this.policy.allowTools)return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Tool execution is disabled by policy."}};
    const permission=toolPermission(this.policy,call.tool,descriptor.effects);
    if(permission.allow===false)return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:`Tool execution is disabled by policy: ${call.tool}`}};
    const assessment=assessAction({runId:context.runId,principalId:context.principalId,toolName:call.tool,input:call.input,effects:descriptor.effects},this.policy.blockedPaths,this.policy.allowedHosts);
    if(!assessment.allowed){
      await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"deny",reason:assessment.reason,input:call.input});
      return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:assessment.reason??"Security policy denied the action."}};
    }
    if(riskRank[assessment.risk]>riskRank[this.policy.maxRisk]){
      await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"deny",reason:"Risk exceeds policy maximum.",input:call.input});
      return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Action risk exceeds Sofia security policy."}};
    }
    const requiresApproval=permission.requireApproval===true||assessment.requireApproval||descriptor.effects.some(x=>x==="write"||x==="shell"||x==="destructive"||x==="browser");
    await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:requiresApproval?"approval_required":"allow",input:call.input});
    if(requiresApproval&&context.requireApproval){
      if(!this.approval)return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Approval is required for this tool."}};
      context.notifyApproval(true);
      try{
        const approved=await this.approval({runId:context.runId,principalId:context.principalId,toolName:call.tool,input:call.input,actionHash:assessment.actionHash,risk:assessment.risk});
        if(!approved){
          await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"approval_denied",reason:"Approval handler denied the exact action.",input:call.input});
          return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Tool execution was not approved."}};
        }
      }finally{context.notifyApproval(false);}
    }
    try{
      this.security.assertRunning();
      const tool=this.dependencies.tools.get(call.tool);
      if(!tool)return{ok:false,data:null,evidenceId,error:{category:"tool_error",message:"Tool disappeared during execution."}};
      const data=await tool.execute(call.input,{runtime:this.dependencies.runtime,signal:context.signal});
      await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"completed",input:call.input,result:data});
      return{ok:true,data,evidenceId};
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"failed",reason:message,input:call.input});
      return{ok:false,data:null,evidenceId,error:{category:descriptor.effects.includes("network")?"network_error":"tool_error",message}};
    }
  }

  async snapshot(signal:AbortSignal):Promise<WorkspaceSnapshot>{
    signal.throwIfAborted();this.security.assertRunning();
    const result=await this.dependencies.runtime.git(["status","--porcelain","--untracked-files=all"]);
    const files=result.code===0?result.stdout.split(/\r?\n/).map(x=>x.slice(3).trim()).filter(Boolean).sort():[];
    const revision=digest(result.code===0?result.stdout:`non-git:${await this.dependencies.runtime.cwd()}`);
    const id=randomUUID();const fingerprints:Record<string,string>={};
    for(const file of files){try{fingerprints[file]=digest(await this.dependencies.runtime.readFile(file));}catch{fingerprints[file]="<missing>";}}
    this.snapshots.set(id,{id,revision,files,fingerprints});return{id,revision,evidenceId:randomUUID()};
  }
  async changedFiles(baselineSnapshotId:string,signal:AbortSignal):Promise<string[]>{
    signal.throwIfAborted();const baseline=this.snapshots.get(baselineSnapshotId);if(!baseline)throw new Error("Unknown baseline snapshot");
    const current=await this.snapshot(signal);const record=this.snapshots.get(current.id)!;
    return[...new Set([...baseline.files,...record.files])].sort().filter(file=>baseline.fingerprints[file]!==record.fingerprints[file]);
  }
  async checkpoint(signal:AbortSignal):Promise<WorkspaceCheckpoint>{this.security.assertRunning();const c=await this.checkpoints.create(signal);return{id:c.id,revision:c.revision};}
  async rollback(id:string,signal:AbortSignal):Promise<string[]>{this.security.assertRunning();return(await this.checkpoints.rollback(id,signal)).restoredFiles;}
}
