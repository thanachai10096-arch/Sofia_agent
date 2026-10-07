import type { ModelProvider, ModelRoute, TaskKind, ToolCall } from "../models/types.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import type { ExecutionPolicy } from "../security/policy.js";
import type { ToolRegistry } from "../tools/types.js";
export interface AgentRequest { task:string; context?:string; sessionId?:string; maxSteps?:number; onEvent?:(event:AgentEvent)=>void; }
export interface AgentEvent { type:"run.started"|"task.classified"|"model.selected"|"model.completed"|"tool.started"|"tool.completed"|"tool.failed"|"review.started"|"review.completed"|"retry"|"run.completed"|"run.failed"; message:string; step?:number; metadata?:Record<string,unknown>; }
export interface AgentResult { runId:string; output:string; kind:TaskKind; steps:number; events:AgentEvent[]; }
export interface AgentDependencies {
 provider:ModelProvider;
 router:{select(kind:TaskKind):ModelRoute;markUnhealthy(id:string):void};
 reviewer:{review(task:string,output:string):Promise<{approved:boolean;reason:string}>};
 runtime:WorkspaceRuntime;
 tools:ToolRegistry;
 policy:ExecutionPolicy;
}
export type { ToolCall };