import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalBroker } from "./approval.js";

const request={
  runId:"run-1",
  principalId:"owner-a",
  toolName:"workspace.write_file",
  input:{path:"safe.txt",content:"approved"},
  actionHash:"sha256-action-a",
  risk:"high" as const,
};

test("approval broker binds decisions to principal and exact action hash", async () => {
  const broker=new ApprovalBroker();
  const result=broker.handle(request);
  const [pending]=broker.pending("owner-a");
  assert.ok(pending);
  assert.equal(broker.pending("owner-b").length,0);
  assert.equal(broker.decide({approvalId:pending.id,principalId:"owner-b",actionHash:request.actionHash,approved:true}),false);
  assert.equal(broker.decide({approvalId:pending.id,principalId:"owner-a",actionHash:"different-action",approved:true}),false);
  assert.equal(broker.decide({approvalId:pending.id,principalId:"owner-a",actionHash:request.actionHash,approved:true}),true);
  assert.equal(await result,true);
  assert.equal(broker.decide({approvalId:pending.id,principalId:"owner-a",actionHash:request.actionHash,approved:true}),false);
});

test("approval broker rejects requests without an authenticated principal", async () => {
  const broker=new ApprovalBroker();
  assert.equal(await broker.handle({...request,principalId:undefined}),false);
  assert.deepEqual(broker.pending("owner-a"),[]);
});

test("approval broker cancels only the matching owner's pending run", async () => {
  const broker=new ApprovalBroker();
  const result=broker.handle(request);
  const [pending]=broker.pending("owner-a");
  assert.ok(pending);
  assert.equal(broker.cancelRun("run-1","owner-b"),0);
  assert.equal(broker.cancelRun("run-1","owner-a"),1);
  assert.equal(await result,false);
});
