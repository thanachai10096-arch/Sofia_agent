export type TaskKind = "coding"|"debugging"|"research"|"analysis"|"vision"|"general";
export type ModelCapability = "fast"|"reasoning"|"coding"|"vision"|"long-context"|"tool-use";
export interface ModelRoute { id:string; providerId?:string; capabilities:ModelCapability[]; costWeight:number; latencyWeight:number; qualityWeight:number; healthy:boolean; }
export interface ChatMessage { role:"system"|"user"|"assistant"|"tool"; content:string; toolCallId?:string; toolCalls?:Array<{id:string;name:string;arguments:string}>; }
export interface ToolDefinition { type:"function"; function:{name:string;description:string;parameters:Record<string,unknown>}; }
export interface ModelRequest { task:string; kind:TaskKind; context?:string; step:number; principalId?: string; messages?:ChatMessage[]; tools?:ToolDefinition[]; }
export interface ModelUsage { inputTokens: number; outputTokens: number; }
export interface ModelResponse { text:string; confidence?:number; toolCalls?:ToolCall[]; assistantMessage?:ChatMessage; usage?:ModelUsage; }
export interface ToolCall { id:string; name:string; input:Record<string,unknown>; }
export interface ModelProvider {
  generate(
    request: ModelRequest,
    route: ModelRoute,
    options?: { signal?: AbortSignal; maxOutputTokens?: number },
  ): Promise<ModelResponse>;
}