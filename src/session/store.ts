export interface Session { id:string; messages:string[]; updatedAt:number; }
export interface SessionSearchOptions { limit?: number; offset?: number; sessionIdPrefix?: string; }
export class MemorySessionStore {
 private sessions=new Map<string,Session>();
 get(id:string){ return this.sessions.get(id); }
 getOrCreate(id:string){ const s=this.sessions.get(id); if(s)return s; const created={id,messages:[],updatedAt:Date.now()}; this.sessions.set(id,created); return created; }
 save(s:Session){ s.updatedAt=Date.now(); this.sessions.set(s.id,s); }
 delete(id:string){ this.sessions.delete(id); }
 search(query:string, options:SessionSearchOptions = {}):Session[] {
  const terms=[...new Set(query.toLocaleLowerCase().split(/\s+/u).filter(Boolean))].slice(0,16);
  if(terms.length===0)return [];
  const limit=Math.max(1,Math.min(20,Math.floor(options.limit??5)));
  const offset=Math.max(0,Math.floor(options.offset??0));
  return [...this.sessions.values()]
   .filter(session=>!options.sessionIdPrefix||session.id.startsWith(options.sessionIdPrefix))
   .map(session=>({session,score:session.messages.reduce((score,message)=>score+terms.reduce((n,term)=>n+(message.toLocaleLowerCase().includes(term)?1:0),0),0)}))
   .filter(item=>item.score>0)
   .sort((a,b)=>b.score-a.score||b.session.updatedAt-a.session.updatedAt)
   .slice(offset,offset+limit)
   .map(item=>({...item.session,messages:[...item.session.messages]}));
 }
}
