export interface UsageRecord { keyId:string; runs:number; toolCalls:number; startedAt:number; }
export class UsageLimiter {
 private readonly records=new Map<string,UsageRecord>();
 constructor(private readonly maxRunsPerKey=100,private readonly maxToolCallsPerKey=1000){
  if(!Number.isSafeInteger(maxRunsPerKey)||maxRunsPerKey<0)throw new Error("Invalid maxRunsPerKey quota.");
  if(!Number.isSafeInteger(maxToolCallsPerKey)||maxToolCallsPerKey<0)throw new Error("Invalid maxToolCallsPerKey quota.");
 }
 consume(keyId:string,toolCalls=0){if(!Number.isSafeInteger(toolCalls)||toolCalls<0)throw new Error("Invalid tool call usage amount.");const now=Date.now();const current=this.records.get(keyId)??{keyId,runs:0,toolCalls:0,startedAt:now};if(now-current.startedAt>=86400000){current.runs=0;current.toolCalls=0;current.startedAt=now;}if(current.runs>=this.maxRunsPerKey||current.toolCalls+toolCalls>this.maxToolCallsPerKey)throw new Error("API usage quota exceeded.");current.runs++;current.toolCalls+=toolCalls;this.records.set(keyId,current);}
 refundRun(keyId:string){const current=this.records.get(keyId);if(!current)return;if(Date.now()-current.startedAt>=86400000){this.records.delete(keyId);return;}current.runs=Math.max(0,current.runs-1);if(current.runs===0&&current.toolCalls===0)this.records.delete(keyId);}
 get(keyId:string){return this.records.get(keyId)??{keyId,runs:0,toolCalls:0,startedAt:Date.now()};}
}