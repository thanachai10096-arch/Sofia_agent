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

test("rejects expired, oversized, and past-deadline messages", () => {
  const limits = { maxMessages: 5, maxHops: 4, maxPayloadBytes: 16, maxAgeMs: 1000 };
  const bus = new AgentMessageBus(scope, agents, limits);
  const expired = createAgentMessage({ correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel", kind: "task", payload: {}, createdAt: 1 });
  assert.throws(() => bus.publish(expired, 5000), (error: unknown) => error instanceof CoordinationError && error.code === "INVALID_MESSAGE");
  const oversized = createAgentMessage({ correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel", kind: "task", payload: { text: "x".repeat(100) } });
  assert.throws(() => bus.publish(oversized), (error: unknown) => error instanceof CoordinationError && error.code === "BUDGET_EXCEEDED");
  const expiredScope: AgentTaskScope = { ...scope, deadlineEpochMs: 100 };
  const deadlineBus = new AgentMessageBus(expiredScope, agents);
  const inTime = createAgentMessage({ correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel", kind: "task", payload: {}, createdAt: 101 });
  assert.throws(() => deadlineBus.publish(inTime, 101), (error: unknown) => error instanceof CoordinationError && error.code === "BUDGET_EXCEEDED");
});
test("enforces the per-agent delegation budget and hop boundary", () => {
  const authorizer = new DelegationAuthorizer(agents, scope, {
    maxHops: 2, maxDelegationsPerAgent: 1,
    allowedRoles: new Set(["coder", "security"]),
    neverDelegateTools: new Set(["secrets.read"]),
  });
  const first = { requesterId: "sofia", recipientId: "pixel", jobId: "job-1", requestedTools: ["workspace.write"], hop: 0, purpose: "Do scoped work" };
  assert.equal(authorizer.authorize(first).allowed, true);
  assert.equal(authorizer.authorize(first).allowed, false);
  assert.equal(authorizer.authorize({ ...first, requesterId: "pixel", recipientId: "velvet", requestedTools: ["workspace.read"], hop: 2 }).allowed, false);
});

test("rejects non-finite hops and malformed delegation payloads", () => {
  const authorizer = new DelegationAuthorizer(agents, scope);
  const base = { requesterId: "sofia", recipientId: "pixel", jobId: "job-1", requestedTools: ["workspace.write"], hop: 0, purpose: "Scoped work" };
  assert.equal(authorizer.authorize({ ...base, hop: Number.NaN }).allowed, false);
  assert.equal(authorizer.authorize({ ...base, hop: Number.POSITIVE_INFINITY }).allowed, false);
  assert.equal(authorizer.authorize({ ...base, requestedTools: ["" as string] }).allowed, false);
  assert.equal(authorizer.authorize({ ...base, purpose: "   " }).allowed, false);
  const invalidPolicy = new DelegationAuthorizer(agents, scope, {
    maxHops: Number.NaN, maxDelegationsPerAgent: 8,
    allowedRoles: new Set(["coder"]), neverDelegateTools: new Set(),
  });
  assert.equal(invalidPolicy.authorize(base).allowed, false);
});


test("queued messages are snapshotted and revalidated when consumed", () => {
  const deadlineScope: AgentTaskScope = { ...scope, deadlineEpochMs: 2_000 };
  const bus = new AgentMessageBus(deadlineScope, agents);
  const message = createAgentMessage({
    id: "snapshot-message",
    correlationId: "job-1",
    jobId: "job-1",
    from: "sofia",
    to: "pixel",
    kind: "task",
    payload: { objective: "approved objective" },
    createdAt: 1_000,
  });
  bus.publish(message, 1_000);
  (message.payload as { objective: string }).objective = "mutated after validation";
  const received = bus.takeFor("pixel", 1_500);
  assert.equal((received?.payload as { objective: string }).objective, "approved objective");

  const expiring = new AgentMessageBus(deadlineScope, agents);
  expiring.publish(createAgentMessage({
    id: "expires-in-queue",
    correlationId: "job-1",
    jobId: "job-1",
    from: "sofia",
    to: "pixel",
    kind: "task",
    payload: {},
    createdAt: 1_000,
  }), 1_000);
  assert.throws(
    () => expiring.takeFor("pixel", 2_001),
    (error: unknown) => error instanceof CoordinationError && error.code === "BUDGET_EXCEEDED",
  );
});

test("message bus refuses consumption by an unregistered identity", () => {
  const bus = new AgentMessageBus(scope, agents);
  assert.throws(
    () => bus.takeFor("rogue"),
    (error: unknown) => error instanceof CoordinationError && error.code === "POLICY_DENIED",
  );
});


test("rejects invalid coordination limits and unbounded envelope metadata", () => {
  assert.throws(() => new AgentMessageBus(scope, agents, {
    maxMessages: 0, maxHops: 4, maxPayloadBytes: 100, maxAgeMs: 1000,
  }), (error: unknown) => error instanceof CoordinationError && error.code === "BUDGET_EXCEEDED");
  const bus = new AgentMessageBus(scope, agents);
  const tooManyEvidence = createAgentMessage({
    correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel",
    kind: "evidence", payload: {}, evidenceIds: Array.from({ length: 257 }, (_, i) => String(i)),
  });
  assert.throws(() => bus.publish(tooManyEvidence), (error: unknown) => error instanceof CoordinationError && error.code === "INVALID_MESSAGE");
  const tooLongId = createAgentMessage({
    correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel",
    kind: "task", payload: {}, id: "x".repeat(257),
  });
  assert.throws(() => bus.publish(tooLongId), (error: unknown) => error instanceof CoordinationError && error.code === "INVALID_MESSAGE");
});


test("bus snapshots host scope, agent identities, and limits at construction", () => {
  const mutableAllowedTools = ["workspace.read"];
  const mutableScope: AgentTaskScope = {
    jobId: "job-1", objective: "Original objective", allowedTools: mutableAllowedTools,
    maxHops: 4, deadlineEpochMs: 5_000,
  };
  const mutableAgents = new Map<string, AgentIdentity>([
    ["sofia", { id: "sofia", role: "orchestrator", capabilities: ["workspace.read"] }],
    ["pixel", { id: "pixel", role: "coder", capabilities: ["workspace.read"] }],
  ]);
  const mutableLimits = { maxMessages: 2, maxHops: 4, maxPayloadBytes: 1024, maxAgeMs: 1000 };
  const bus = new AgentMessageBus(mutableScope, mutableAgents, mutableLimits);

  mutableScope.jobId = "other-job";
  mutableAllowedTools.push("secrets.read");
  mutableAgents.delete("pixel");
  mutableLimits.maxMessages = 0;

  const message = createAgentMessage({
    id: "scope-snapshot",
    correlationId: "job-1",
    jobId: "job-1",
    from: "sofia",
    to: "pixel",
    kind: "task",
    payload: {},
    createdAt: 1_000,
  });
  bus.publish(message, 1_000);
  assert.equal(bus.takeFor("pixel", 1_100)?.id, "scope-snapshot");
});

test("close discards queued work and prevents later consumption", () => {
  const bus = new AgentMessageBus(scope, agents);
  bus.publish(createAgentMessage({
    correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel",
    kind: "proposal", payload: { tool: "workspace.write" },
  }));
  assert.equal(bus.pendingCount(), 1);
  bus.close();
  assert.equal(bus.pendingCount(), 0);
  assert.throws(
    () => bus.takeFor("pixel"),
    (error: unknown) => error instanceof CoordinationError && error.code === "CANCELLED",
  );
});


test("rejects malformed task scopes and inconsistent agent identities", () => {
  assert.throws(
    () => new AgentMessageBus({ ...scope, maxHops: Number.NaN }, agents),
    (error: unknown) => error instanceof CoordinationError && error.code === "SCOPE_VIOLATION",
  );
  assert.throws(
    () => new AgentMessageBus({ ...scope, deadlineEpochMs: Number.NaN }, agents),
    (error: unknown) => error instanceof CoordinationError && error.code === "SCOPE_VIOLATION",
  );
  const inconsistent = new Map(agents);
  inconsistent.set("pixel-alias", agents.get("pixel")!);
  assert.throws(
    () => new AgentMessageBus(scope, inconsistent),
    (error: unknown) => error instanceof CoordinationError && error.code === "POLICY_DENIED",
  );
});


test("preserves host-authenticated principal binding in the scope snapshot", () => {
  const principalScope: AgentTaskScope = { ...scope, principalId: "user-123" };
  const bus = new AgentMessageBus(principalScope, agents);
  principalScope.principalId = "attacker";
  const message = createAgentMessage({
    correlationId: "job-1", jobId: "job-1", from: "sofia", to: "pixel",
    kind: "task", payload: {},
  });
  bus.publish(message);
  assert.equal(bus.takeFor("pixel")?.jobId, "job-1");
  assert.throws(
    () => new AgentMessageBus({ ...scope, principalId: "x".repeat(257) }, agents),
    (error: unknown) => error instanceof CoordinationError && error.code === "SCOPE_VIOLATION",
  );
});
