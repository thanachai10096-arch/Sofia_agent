import type { ModelProvider, ModelRoute, TaskKind, ToolCall } from "../models/types.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import type { ExecutionPolicy } from "../security/policy.js";
import type { ToolRegistry } from "../tools/types.js";
import type { AcceptanceCriterion, BrainEvent, CompletionReport } from "../brain/types.js";
import type { SofiaBrain } from "../brain/executor.js";
import type { JobRuntime } from "../brain/job-runtime.js";
import type { BrainRunSnapshot } from "../brain/run-state.js";
import type { SecurityController } from "../security/controller.js";
import type { SecurityAuditSink } from "../security/audit.js";
import type { DesktopCapability } from "../desktop/types.js";
export interface AgentRequest {
  task: string;
  context?: string;
  sessionId?: string;
  principalId?: string;
  /** Desktop capabilities are derived by the trusted host from authenticated scopes. */
  desktopCapabilities?: DesktopCapability[];
  maxSteps?: number;
  acceptanceCriteria?: AcceptanceCriterion[];
  useBrain?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}
export interface AgentEvent { type:"run.started"|"task.classified"|"model.selected"|"model.completed"|"tool.started"|"tool.completed"|"tool.failed"|"tool.output_suspicious"|"tool.approval_required"|"review.started"|"review.completed"|"retry"|"run.completed"|"run.failed"; message:string; step?:number; metadata?:Record<string,unknown>; }
export interface AgentResult {
  runId: string;
  output: string;
  kind: TaskKind;
  steps: number;
  events: AgentEvent[];
  brainReport?: CompletionReport;
}
export interface AgentDependencies {
 provider:ModelProvider;
 router:{select(kind:TaskKind):ModelRoute;markUnhealthy(id:string):void};
 reviewer:{review(task:string,output:string):Promise<{approved:boolean;reason:string}>};
 runtime?:WorkspaceRuntime;
 tools?:ToolRegistry;
 policy?:ExecutionPolicy;
 approval?: import("./approval.js").ApprovalHandler;
 brainFactory?: (options:{signal?:AbortSignal;maxSteps?:number;principalId?:string;desktopCapabilities?:DesktopCapability[];onRunSnapshot?: (snapshot: BrainRunSnapshot) => void | Promise<void>;onEvent?: (event: BrainEvent) => void})=>SofiaBrain;
 jobRuntime?: JobRuntime;
 securityController?: SecurityController;
 securityAudit?: SecurityAuditSink;
 /** Optional transcript store; used only when sessionId is provided. */
 /** Optional explicit user-scoped memory store; writes require an explicit API action. */
 userMemoryStore?: import("../brain/user-memory.js").UserMemoryStore;
 sessionStore?: { getOrCreate(id: string): { id: string; messages: string[]; updatedAt: number }; save(session: { id: string; messages: string[]; updatedAt: number }): void; search?(query: string, options?: { limit?: number; offset?: number; ownerPrefix?: string }): Array<{ id: string; messages: string[]; updatedAt: number }>; };
 learningDiagnostics?: () => unknown;
}
export type { ToolCall };