import {test} from "node:test";import assert from "node:assert/strict";import {mkdtemp,rm,writeFile} from "node:fs/promises";import os from "node:os";import path from "node:path";import {createHash} from "node:crypto";import {createSofiaApi} from "../../src/api/server.js";import {FileRunRecordStore} from "../../src/api/run-record-store.js";import type {AgentDependencies} from "../../src/agent/types.js";
const KEY="persist-test-key";const listen=(s:ReturnType<typeof createSofiaApi>)=>new Promise<string>((resolve,reject)=>{s.once("error",reject);s.listen(0,"127.0.0.1",()=>{const a=s.address();assert.ok(a&&typeof a!=="string");resolve("http://127.0.0.1:"+a.port);});});const close=(s:ReturnType<typeof createSofiaApi>)=>new Promise<void>((resolve,reject)=>s.close(e=>e?reject(e):resolve()));
test("async idempotency binding survives an API restart when run persistence is configured", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-idempotency-restart-"));
  const store = new FileRunRecordStore(directory);
  let firstServer: ReturnType<typeof createSofiaApi> | undefined;
  let secondServer: ReturnType<typeof createSofiaApi> | undefined;
  try {
    firstServer = createSofiaApi({} as AgentDependencies, {
      apiKeys: { "test-token": ["agent:run"] }, runStore: store, requestTimeoutMs: 5000,
    });
    const firstUrl = await listen(firstServer);
    const headers = { authorization: "Bearer test-token", "content-type": "application/json", "idempotency-key": "restart-safe-key" };
    const firstResponse = await fetch(firstUrl + "/v1/agent/runs", {
      method: "POST", headers, body: JSON.stringify({ task: "same request", async: true }),
    });
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json() as { id: string };
    await new Promise((resolve) => setTimeout(resolve, 100));
    await close(firstServer);
    firstServer = undefined;

    secondServer = createSofiaApi({} as AgentDependencies, {
      apiKeys: { "test-token": ["agent:run"] }, runStore: new FileRunRecordStore(directory), requestTimeoutMs: 5000,
    });
    const secondUrl = await listen(secondServer);
    const retry = await fetch(secondUrl + "/v1/agent/runs", {
      method: "POST", headers, body: JSON.stringify({ async: true, task: "same request" }),
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { id: string }).id, first.id);
    const conflict = await fetch(secondUrl + "/v1/agent/runs", {
      method: "POST", headers, body: JSON.stringify({ task: "different request", async: true }),
    });
    assert.equal(conflict.status, 409);
  } finally {
    if (firstServer?.listening) await close(firstServer);
    if (secondServer?.listening) await close(secondServer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("async run is not acknowledged when durable run persistence fails", async () => {
  let saveCalls = 0;
  const failingStore = {
    async save() { saveCalls += 1; throw new Error("disk unavailable"); },
    async remove() {},
    loadAllSync() { return []; },
  };
  const server = createSofiaApi({} as AgentDependencies, {
    apiKeys: { [KEY]: ["agent:run"] }, runStore: failingStore, requestTimeoutMs: 5000,
  });
  const base = await listen(server);
  try {
    const response = await fetch(base + "/v1/agent/runs", {
      method: "POST",
      headers: { authorization: "Bearer " + KEY, "content-type": "application/json", "idempotency-key": "must-not-acknowledge" },
      body: JSON.stringify({ task: "do not run without durable state", async: true }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: string }).error, "run_persistence_unavailable");
    assert.equal(saveCalls, 1);
  } finally {
    await close(server);
  }
});

test("finished runs survive restart; queued/running become failed and remain owner-scoped",async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),"sofia-runs-"));try{const owner=createHash("sha256").update(KEY).digest("hex").slice(0,32),done="22222222-2222-2222-2222-222222222222",running="33333333-3333-3333-3333-333333333333",store=new FileRunRecordStore(dir);await store.save({id:done,status:"completed",createdAt:Date.now(),updatedAt:Date.now(),ownerKeyId:owner,desktopCapabilities:[],result:{runId:done,output:"done",kind:"general",steps:1,events:[]} as never});await store.save({id:running,status:"running",createdAt:Date.now(),updatedAt:Date.now(),ownerKeyId:owner,desktopCapabilities:[]});const server=createSofiaApi({} as AgentDependencies,{apiKeys:{[KEY]:["agent:run"]},runStore:new FileRunRecordStore(dir)}),base=await listen(server);try{const h={authorization:"Bearer "+KEY};const a=await(await fetch(base+"/v1/agent/runs/"+done,{headers:h})).json() as {status:string;result?:{output:string}};assert.equal(a.status,"completed");assert.equal(a.result?.output,"done");const b=await(await fetch(base+"/v1/agent/runs/"+running,{headers:h})).json() as {status:string;error?:string};assert.equal(b.status,"failed");assert.match(b.error??"",/interrupted by server restart/);assert.equal((await fetch(base+"/v1/agent/runs/"+done,{headers:{authorization:"Bearer nope"}})).status,401);}finally{await close(server);} }finally{await rm(dir,{recursive:true,force:true});}});
test("corrupt and path-traversal record files are ignored",async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),"sofia-runs-"));try{await writeFile(path.join(dir,"corrupt.json"),"{bad");await writeFile(path.join(dir,"bad.json"),JSON.stringify({id:"../evil"}));assert.equal(new FileRunRecordStore(dir).loadAllSync().length,0);}finally{await rm(dir,{recursive:true,force:true});}});

test("invalid status, timestamps, capabilities, and result payloads are discarded",async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),"sofia-runs-invalid-"));try{const base={id:"44444444-4444-4444-4444-444444444444",status:"completed",createdAt:10,updatedAt:11,ownerKeyId:createHash("sha256").update(KEY).digest("hex").slice(0,32),desktopCapabilities:[],result:{runId:"44444444-4444-4444-4444-444444444444",output:"ok",kind:"general",steps:1,events:[]}};await writeFile(path.join(dir,base.id+".json"),JSON.stringify({...base,result:{...base.result,kind:"admin"}}));const invalidStatus={...base,id:"55555555-5555-5555-5555-555555555555",status:"root"};await writeFile(path.join(dir,invalidStatus.id+".json"),JSON.stringify(invalidStatus));const invalidCaps={...base,id:"66666666-6666-6666-6666-666666666666",desktopCapabilities:["shell:root"]};await writeFile(path.join(dir,invalidCaps.id+".json"),JSON.stringify(invalidCaps));assert.deepEqual(new FileRunRecordStore(dir).loadAllSync(),[]);}finally{await rm(dir,{recursive:true,force:true});}});
test("removing a run deletes its persisted record",async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),"sofia-runs-remove-"));try{const id="77777777-7777-7777-7777-777777777777";const store=new FileRunRecordStore(dir);await store.save({id,status:"failed",createdAt:10,updatedAt:11,ownerKeyId:createHash("sha256").update(KEY).digest("hex").slice(0,32),desktopCapabilities:[],error:"interrupted"});assert.equal(store.loadAllSync().length,1);await store.remove(id);assert.equal(store.loadAllSync().length,0);}finally{await rm(dir,{recursive:true,force:true});}});
