import { createHash } from "node:crypto";

/** Derive an opaque, stable session key from the authenticated principal and caller session ID. */
export function scopedSessionId(ownerId: string, sessionId: string): string {
 if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 512) throw new Error("A valid authenticated owner is required.");
 if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 512) throw new Error("A valid session ID is required.");
 return createHash("sha256").update(JSON.stringify([ownerId, sessionId])).digest("hex");
}

export interface Session { id:string; messages:string[]; updatedAt:number; }
export class MemorySessionStore {
 private sessions=new Map<string,Session>();
 get(id:string){ return this.sessions.get(id); }
 getOrCreate(id:string){ const s=this.sessions.get(id); if(s)return s; const created={id,messages:[],updatedAt:Date.now()}; this.sessions.set(id,created); return created; }
 save(s:Session){ s.updatedAt=Date.now(); this.sessions.set(s.id,s); }
 delete(id:string){ this.sessions.delete(id); }
}