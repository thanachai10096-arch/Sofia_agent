import { randomUUID } from "node:crypto";
import { classifyTask } from "./classifier.js";
import type { AgentDependencies, AgentEvent, AgentRequest, AgentResult } from "./types.js";
import type { ChatMessage, ToolDefinition } from "../models/types.js";
import { assertSafeStep, assertToolAllowed, loadExecutionPolicyFromEnv } from "../security/policy.js";
export class SofiaAgent {
 constructor(private readonly deps:AgentDependencies){}
 async run(request:AgentRequest):Promise<AgentResult>{
  const runId=randomUUID(); const events:AgentEvent[]=[]; const emit=(event:AgentEvent)=>{events.push(event);request.onEvent?.(event);}; emit({type:"run.started",message:"Sofia run started."});
  const kind=classifyTask(request.task); emit({type:"task.classified",message:`Task classified as ${kind}.`,metadata:{kind}});
  const policy=this.deps.policy ?? loadExecutionPolicyFromEnv(); const maxSteps=Math.min(request.maxSteps??policy.maxSteps,policy.maxSteps);
  const messages:ChatMessage[]=[{role:"system",content:"You are Sofia. Complete the user's task by reasoning and using tools. Work inside the provided workspace. Do not claim a change was made unless a tool confirms it."},{role:"user",content:request.task},...(request.context?[{role:"user",content:`Workspace context:\n${request.context}`}]:[])];
  const toolDefs:ToolDefinition[]=this.deps.tools.list().map(t=>({type:"function",function:{name:t.name,description:t.description,parameters:t.inputSchema}}));
  let lastError:unknown=null;
  for(let step=1;step<=maxSteps;step++){
   try{
    assertSafeStep(policy,step); const route=this.deps.router.select(kind);
    emit({type:"model.selected",message:"Internal model route selected.",step});
    const response=await this.deps.provider.generate({task:request.task,kind,context:request.context,step,messages,tools:toolDefs},route);
    if(response.assistantMessage) messages.push(response.assistantMessage);
    emit({type:"model.completed",message:"Model step completed.",step});
    if(response.toolCalls?.length){
     if(response.toolCalls.length>policy.maxToolCallsPerStep) throw new Error("Too many tool calls requested in one step.");
     for(const call of response.toolCalls){
      assertToolAllowed(policy,call.name); const tool=this.deps.tools.get(call.name);
      if(!tool) throw new Error(`Unknown tool: ${call.name}`);
      emit({type:"tool.started",message:`Running ${call.name}.`,step,metadata:{tool:call.name}});
      if(this.deps.approval){const approved=await this.deps.approval({runId,toolName:call.name,input:call.input});if(!approved){emit({type:"tool.approval_required",message:`Tool ${call.name} was not approved.`,step,metadata:{tool:call.name}});messages.push({role:"tool",content:JSON.stringify({error:"Tool execution not approved"}),toolCallId:call.id});continue;}}
      try{
       const result=await tool.execute(call.input,{runtime:this.deps.runtime});
       const content=JSON.stringify(result); messages.push({role:"tool",content,toolCallId:call.id});
       emit({type:"tool.completed",message:`${call.name} completed.`,step,metadata:{tool:call.name}});
      }catch(error){
       const message=error instanceof Error?error.message:String(error); messages.push({role:"tool",content:JSON.stringify({error:message}),toolCallId:call.id});
       emit({type:"tool.failed",message,step,metadata:{tool:call.name}});
      }
     }
     continue;
    }
    if(!response.text.trim()) throw new Error("Agent produced no final response.");
    emit({type:"review.started",message:"Reviewing model result.",step});
    const review=await this.deps.reviewer.review(request.task,response.text);
    emit({type:"review.completed",message:review.reason,step,metadata:{approved:review.approved}});
    if(review.approved){emit({type:"run.completed",message:"Sofia run completed."});return {runId,output:response.text,kind,steps:step,events};}
    lastError=new Error(review.reason); this.deps.router.markUnhealthy(route.id);
   }catch(error){lastError=error;emit({type:"retry",message:error instanceof Error?error.message:"Internal step failed.",step});}
  }
  const message=lastError instanceof Error?lastError.message:"Agent failed"; emit({type:"run.failed",message}); throw new Error(`Sofia failed after ${maxSteps} steps: ${message}`);
 }
}