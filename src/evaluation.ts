import type { AgentRequest, AgentResult } from "./agent/types.js";

export interface EvaluationCase {
  id: string; task: string; acceptanceCriteria: string[]; expected?: Record<string, unknown>; tags?: string[];
}
export interface EvaluationResult {
  caseId: string; passed: boolean; score: number; durationMs: number; details: string;
}
export interface EvaluationRunner {
  run(testCase: EvaluationCase): Promise<EvaluationResult>;
}
export class AgentEvaluationRunner implements EvaluationRunner {
  constructor(private readonly runAgent:(request:AgentRequest)=>Promise<AgentResult>) {}
  async run(testCase:EvaluationCase):Promise<EvaluationResult>{
    const started=Date.now();
    try{
      const result=await this.runAgent({task:testCase.task,useBrain:true,acceptanceCriteria:testCase.acceptanceCriteria.map((description,index)=>({
        id:`eval:${testCase.id}:${index}`,description,
        probe:{tool:"project.verify",input:{kind:"typecheck"}},
        evaluate:(value)=>({passed:Boolean((value as {passed?:unknown})?.passed),detail:"evaluation probe"}),
      }))});
      return{caseId:testCase.id,passed:result.brainReport?.completed===true,score:result.brainReport?.completed?1:0,durationMs:Date.now()-started,details:result.output};
    }catch(error){return{caseId:testCase.id,passed:false,score:0,durationMs:Date.now()-started,details:error instanceof Error?error.message:String(error)};}
  }
}
