import assert from "node:assert/strict";
import test from "node:test";
import { PostgresOutboxStore } from "./postgres-outbox-store.js";
import type { PostgresExecutor } from "./postgres-job-state-store.js";

const uuidA="00000000-0000-4000-8000-000000000001";
const uuidB="00000000-0000-4000-8000-000000000002";

test("outbox enqueue is idempotent on job, event type, and destination",async()=>{
 const calls:Array<{sql:string;values:unknown[]}>=[];
 const db:PostgresExecutor={async query(sql,values=[]){calls.push({sql,values});return {rows:[],rowCount:0};}};
 const store=new PostgresOutboxStore(db);
 assert.equal(await store.enqueue({id:uuidA,jobId:uuidB,eventType:"job.completed",destination:"discord:channel",payload:{text:"done"},ownerKeyId:"owner"}),false);
 assert.match(calls[0]!.sql,/ON CONFLICT \(job_id,event_type,destination\) DO NOTHING/);
 assert.equal(calls[0]!.values[1],"owner");
});

test("outbox claim uses SKIP LOCKED and returns normalized leased messages",async()=>{
 let captured="";
 const row={
  id:uuidA,owner_key_id:"owner",job_id:uuidB,event_type:"job.completed",destination:"discord:channel",
  payload:{text:"done"},status:"processing",attempts:1,available_at:new Date("2026-11-03T00:00:00Z"),
  lease_owner_token:uuidB,lease_expires_at:new Date("2026-11-03T00:01:00Z"),last_error:null,
  created_at:new Date("2026-11-03T00:00:00Z"),delivered_at:null,
 };
 const db:PostgresExecutor={async query(sql,values=[]){captured=sql;assert.equal(values[1],100);return {rows:[row],rowCount:1};}};
 const store=new PostgresOutboxStore(db);
 const messages=await store.claimBatch(uuidB,1000,60000);
 assert.match(captured,/FOR UPDATE SKIP LOCKED/);
 assert.equal(messages.length,1);
 assert.equal(messages[0]!.status,"processing");
 assert.deepEqual(messages[0]!.payload,{text:"done"});
 assert.equal(messages[0]!.leaseOwnerToken,uuidB);
});

test("outbox acknowledgement and retry are fenced by the active worker lease",async()=>{
 const calls:Array<{sql:string;values:unknown[]}>=[];
 const db:PostgresExecutor={async query(sql,values=[]){calls.push({sql,values});return {rows:[],rowCount:1};}};
 const store=new PostgresOutboxStore(db);
 assert.equal(await store.markDelivered(uuidA,uuidB),true);
 assert.equal(await store.retry(uuidA,uuidB,"temporary error",5000,4),true);
 assert.match(calls[0]!.sql,/lease_owner_token=\$2::uuid/);
 assert.match(calls[0]!.sql,/lease_expires_at>now\(\)/);
 assert.match(calls[1]!.sql,/attempts >= \$5/);
 assert.match(calls[1]!.sql,/lease_owner_token=\$2::uuid/);
});


test("outbox lease renewal extends only a live lease owned by the worker",async()=>{
 let captured="";
 let values:unknown[]=[];
 const db:PostgresExecutor={async query(sql,params=[]){captured=sql;values=params;return {rows:[],rowCount:1};}};
 const store=new PostgresOutboxStore(db);
 assert.equal(await store.renewLease(uuidA,uuidB,60000),true);
 assert.match(captured,/lease_expires_at=now\(\)/);
 assert.match(captured,/status='processing'/);
 assert.match(captured,/lease_owner_token=\$2::uuid/);
 assert.match(captured,/lease_expires_at>now\(\)/);
 assert.deepEqual(values,[uuidA,uuidB,60000]);
});
