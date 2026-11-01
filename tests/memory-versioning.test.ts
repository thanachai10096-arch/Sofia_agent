import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "../src/brain/project-memory.js";
import { listProjectMemoryVersions, rollbackProjectMemory, saveVersionedProjectMemory } from "../src/brain/memory-versioning.js";
class Store implements ProjectMemoryStore {
 entries: ProjectMemoryEntry[]=[];
 async save(e:ProjectMemoryEntry){const i=this.entries.findIndex(x=>x.id===e.id);if(i<0)this.entries.push(e);else this.entries[i]=e;}
 async list(){return [...this.entries];}
 async find(q:string){return this.entries.filter(e=>e.kind!=="version"&&e.content.includes(q));}
}
const original:ProjectMemoryEntry={id:"memory-1",project:"project-a",kind:"decision",content:"Use existing runtime",confidence:0.9,createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z",uses:2};
test("versioned update preserves prior snapshot and excludes it from search",async()=>{
 const store=new Store();await store.save(original);
 const r=await saveVersionedProjectMemory(store,{...original,content:"Use new runtime",updatedAt:"2026-02-01T00:00:00Z"},{actor:"owner",reason:"Approved update",occurredAt:"2026-02-01T00:00:00Z"});
 assert.equal(r.saved,true);assert.equal((await listProjectMemoryVersions(store,"project-a","memory-1")).length,1);
 assert.equal((await store.find("Use existing runtime")).length,0);
});
test("rollback journals current state and restores selected version",async()=>{
 const store=new Store();await store.save(original);
 await saveVersionedProjectMemory(store,{...original,content:"Changed"},{actor:"owner",reason:"Change",occurredAt:"2026-02-01T00:00:00Z"});
 const v=(await listProjectMemoryVersions(store,"project-a","memory-1"))[0]!;
 const r=await rollbackProjectMemory(store,"project-a",v.versionId,{actor:"owner",reason:"Regression",occurredAt:"2026-03-01T00:00:00Z"});
 assert.equal(r.saved,true);assert.equal(r.entry?.content,original.content);assert.equal(r.entry?.createdAt,original.createdAt);
 assert.equal(r.entry?.updatedAt,"2026-03-01T00:00:00Z");assert.equal((await listProjectMemoryVersions(store,"project-a","memory-1")).length,2);
});
test("version history cannot cross project boundaries and rejects invalid metadata",async()=>{
 const store=new Store();await store.save(original);
 const r=await saveVersionedProjectMemory(store,{...original,content:"Updated"},{actor:"owner",reason:"Update",occurredAt:"2026-02-01T00:00:00Z"});
 assert.equal((await rollbackProjectMemory(store,"project-b",r.version!.versionId,{actor:"owner",reason:"Cross project"})).reason,"not-found");
 assert.equal((await saveVersionedProjectMemory(store,original,{actor:"",reason:"Bad"})).reason,"invalid-metadata");
});
