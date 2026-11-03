export interface Session { id:string; messages:string[]; updatedAt:number; }
export class MemorySessionStore {
 private sessions=new Map<string,Session>();
 get(id:string){ return this.sessions.get(id); }
 getOrCreate(id:string){ const s=this.sessions.get(id); if(s)return s; const created={id,messages:[],updatedAt:Date.now()}; this.sessions.set(id,created); return created; }
 save(s:Session){ s.updatedAt=Date.now(); this.sessions.set(s.id,s); }
 search(query:string, options:{limit?:number;offset?:number;ownerPrefix?:string}={}){ const term=query.trim().toLocaleLowerCase(); if(!term)return []; const limit=Number.isSafeInteger(options.limit)?Math.max(1,Math.min(100,options.limit!)):20; const offset=Number.isSafeInteger(options.offset)?Math.max(0,options.offset!):0; return [...this.sessions.values()].filter((session)=>(options.ownerPrefix===undefined||session.id.startsWith(options.ownerPrefix))&&session.messages.some((message)=>message.toLocaleLowerCase().includes(term))).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)).slice(offset,offset+limit).map((session)=>({ ...session, messages:[...session.messages] })); }
 delete(id:string){ this.sessions.delete(id); }
}