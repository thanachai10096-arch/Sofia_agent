export interface Session { id:string; messages:string[]; updatedAt:number; }
export class MemorySessionStore {
 private sessions=new Map<string,Session>();
 get(id:string){ return this.sessions.get(id); }
 getOrCreate(id:string){ const s=this.sessions.get(id); if(s)return s; const created={id,messages:[],updatedAt:Date.now()}; this.sessions.set(id,created); return created; }
 save(s:Session){ s.updatedAt=Date.now(); this.sessions.set(s.id,s); }
 appendMessages(id:string, appended:string[], maxMessages=200){
  if(!id) throw new Error("Session id must not be empty.");
  if(!Array.isArray(appended)||appended.some((message)=>typeof message!=="string")) throw new TypeError("Appended session messages must be an array of strings.");
  if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>1000) throw new RangeError("Expected an integer between 1 and 1000.");
  const current=this.sessions.get(id);
  const messages=[...(current?.messages??[]),...appended].slice(-maxMessages);
  const session={id,messages,updatedAt:Date.now()};
  this.sessions.set(id,session);
  return { ...session, messages: [...messages] };
 }
 delete(id:string){ this.sessions.delete(id); }
}