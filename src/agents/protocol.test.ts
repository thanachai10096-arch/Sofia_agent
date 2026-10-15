import test from "node:test";
import assert from "node:assert/strict";
import { AgentMessageBus, CoordinationError, createAgentMessage, type AgentIdentity, type AgentTaskScope } from "./protocol.js";
import { DelegationAuthorizer } from "../security/delegation-policy.js";

const agents = new Map<string, AgentIdentity>([
  ["sofia", { id: "sofia", role: "orchestrator", capabilities: ["workspace.read", "workspace.write"] }],
  ["pixel", { id: "pixel", role: "coder", capabilities: ["workspace.read", "workspace.write"] }],
  ["velvet", { id: "velvet", role: "security", capabilities: ["workspace.read"] }],
]);
const scope: AgentTaskScope = { jobId: "job-1", objective: "Fix the failing test", allowedTools: ["workspace.read", "workspace.write"], maxHops: 4 };

test("routes valid messages to intended agent", () => {
  const bus = new AgentMessageBus(scope, agents);
  const message = createAgentMessage({ correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel", kind: "task", payload: { objective: "Fix test" } });
  bus.publish(message);
  assert.equal(bus.pendingCount(), 1);
  assert.equal(bus.takeFor("velvet"), undefined);
  assert.equal(bus.takeFor("pixel")?.id, message.id);
  assert.equal(bus.pendingCount(), 0);
});
test("rejects cross-job messages and unregistered agents", () => {
  const bus = new AgentMessageBus(scope, agents);
  const crossJob = createAgentMessage({ correlationId: "job-2", jobId: "job-2", from: "sofia", to: "pixel", kind: "task", payload: {} });
  assert.throws(() => bus.publish(crossJob), (error: unknown) => error instanceof CoordinationError && error.code === "SCOPE_VIOLATION");
  const unknown = createAgentMessage({ correlationId: "job-1", jobId: "job-1", from: "rogue", to: "pixel", kind: "task", payload: {} });
  assert.throws(() => bus.publish(unknown), (error: unknown) => error instanceof CoordinationError && error.code === "POLICY_DENIED");
});
test("rejects duplicate IDs and queue overflow", () => {
  const bus = new AgentMessageBus(scope, agents, { maxMessages: 1, maxHops: 4, maxPayloadBytes: 100, maxAgeMs: 1000 });
  const message = createAgentMessage({ id: "same", correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel", kind: "task", payload: {} });
  bus.publish(message);
  assert.throws(() => bus.publish(message), /Duplicate message ID/);
  assert.throws(() => bus.publish(createAgentMessage({ id: "next", correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel", kind: "task", payload: {} })), /budget exceeded/);
});
test("delegation cannot grant capabilities or privileged tools", () => {
  const authorizer = new DelegationAuthorizer(agents, scope);
  assert.equal(authorizer.authorize({ requesterId: "sofia", recipientId: "pixel", jobId: "job-1", requestedTools: ["workspace.write"], hop: 0, purpose: "Implement approved fix" }).allowed, true);
  assert.equal(authorizer.authorize({ requesterId: "sofia", recipientId: "pixel", jobId: "job-1", requestedTools: ["secrets.read"], hop: 0, purpose: "Read secrets" }).allowed, false);
  assert.equal(authorizer.authorize({ requesterId: "sofia", recipientId: "velvet", jobId: "job-1", requestedTools: ["workspace.write"], hop: 0, purpose: "Grant new access" }).allowed, false);
  assert.equal(authorizer.authorize({ requesterId: "pixel", recipientId: "sofia", jobId: "job-1", requestedTools: [], hop: 0, purpose: "Loop" }).allowed, false);
});
test("closed bus refuses further messages", () => {
  const bus = new AgentMessageBus(scope, agents);
  bus.close();
  assert.throws(() => bus.publish(createAgentMessage({ correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel", kind: "task", payload: {} })), /closed/);
});
