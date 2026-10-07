export interface UsageRecord { keyId:string; runs:number; toolCalls:number; startedAt:number; }
export class UsageLimiter {
 private readonly records=new Map<string,UsageRecord>();
 constructor(private readonly maxRunsPerKey=100,private readonly maxToolCallsPerKey=1000){}
 consume(keyId:string,toolCalls=0){const now=Date.now();const current=this.records.get(keyId)??{keyId,runs:0,toolCalls:0,startedAt:now};if(now-current.startedAt>=86400000){current.runs=0;current.toolCalls=0;current.startedAt=now;}if(current.runs>=this.maxRunsPerKey||current.toolCalls+toolCalls>this.maxToolCallsPerKey)throw new Error("API usage quota exceeded.");current.runs++;current.toolCalls+=toolCalls;this.records.set(keyId,current);}
 get(keyId:string){return this.records.get(keyId)??{keyId,runs:0,toolCalls:0,startedAt:Date.now()};}
}