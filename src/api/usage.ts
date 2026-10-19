export interface UsageRecord { keyId:string; runs:number; toolCalls:number; startedAt:number; }
export class UsageLimiter {
 private readonly records=new Map<string,UsageRecord>();
 constructor(private readonly maxRunsPerKey=100,private readonly maxToolCallsPerKey=1000){
  if(!Number.isSafeInteger(maxRunsPerKey)||maxRunsPerKey<0)throw new Error("Invalid maxRunsPerKey quota.");
  if(!Number.isSafeInteger(maxToolCallsPerKey)||maxToolCallsPerKey<0)throw new Error("Invalid maxToolCallsPerKey quota.");
 }
 consume(keyId:string,toolCalls=0){if(!Number.isSafeInteger(toolCalls)||toolCalls<0)throw new Error("Invalid tool call usage amount.");const now=Date.now();const current=this.records.get(keyId)??{keyId,runs:0,toolCalls:0,startedAt:now};if(now-current.startedAt>=86400000){current.runs=0;current.toolCalls=0;current.startedAt=now;}if(current.runs>=this.maxRunsPerKey||current.toolCalls+toolCalls>this.maxToolCallsPerKey)throw new Error("API usage quota exceeded.");current.runs++;current.toolCalls+=toolCalls;this.records.set(keyId,current);}
 get(keyId:string): UsageRecord {
  const current = this.records.get(keyId);
  // Never expose the mutable record stored internally: callers could otherwise
  // reset counters and bypass per-key quotas by mutating the returned object.
  return current ? { ...current } : { keyId, runs: 0, toolCalls: 0, startedAt: Date.now() };
 }
}