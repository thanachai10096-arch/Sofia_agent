import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_CREATE_SCRIPT,
  APPROVAL_RESOLVE_SCRIPT,
  UpstashApprovalDecisionStore,
} from "./upstash-approval-store.js";
import type { ApprovalRecord } from "./approval-broker.js";

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const now = Date.now();
  return {
    id: "approval-redis-1",
    runId: "run-redis-1",
    principalId: "principal-redis-1",
    toolName: "workspace.write_file",
    input: { path: "safe.txt", content: "safe" },
    actionHash: "a".repeat(64),
    risk: "high",
    status: "pending",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

function response(result: unknown, ok = true): Response {
  return { ok, json: async () => ({ result }) } as unknown as Response;
}

test("Upstash approval store creates with an atomic NX script and a cluster hash tag", async () => {
  let command: unknown[] = [];
  const store = new UpstashApprovalDecisionStore({
    url: "https://redis.example.com",
    token: "test-token",
    fetchImpl: async (_input, init) => {
      command = JSON.parse(String(init?.body)) as unknown[];
      return response(1);
    },
  });
  await store.create(record());
  assert.equal(command[0], "EVAL");
  assert.equal(command[1], APPROVAL_CREATE_SCRIPT);
  assert.equal(command[2], 2);
  const keys = command.slice(3, 5) as string[];
  assert.ok(keys.every((key) => key.includes("{approvals}")));
  assert.ok(keys.every((key) => key.startsWith("sofia:")));
  assert.match(APPROVAL_CREATE_SCRIPT, /'NX', 'PX'/u);
});

test("Upstash approval store reads and validates persisted records", async () => {
  const expected = record();
  const store = new UpstashApprovalDecisionStore({
    url: "https://redis.example.com",
    token: "test-token",
    fetchImpl: async () => response(JSON.stringify(expected)),
  });
  assert.deepEqual(await store.get(expected.id), expected);
});

test("Upstash approval inbox is owner-scoped and removes stale index entries", async () => {
  const owned = record();
  const foreign = record({ id: "approval-redis-2", principalId: "principal-other" });
  const commands: unknown[][] = [];
  const store = new UpstashApprovalDecisionStore({
    url: "https://redis.example.com",
    token: "test-token",
    fetchImpl: async (_input, init) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      commands.push(command);
      if (command[0] === "ZRANGE") return response([owned.id, foreign.id]);
      if (command[0] === "MGET") return response([JSON.stringify(owned), JSON.stringify(foreign)]);
      if (command[0] === "ZREM") return response(1);
      throw new Error("Unexpected Redis command");
    },
  });
  assert.deepEqual(await store.listPending("principal-redis-1"), [owned]);
  assert.equal(commands[0]?.[0], "ZRANGE");
  assert.equal(commands[1]?.[0], "MGET");
  assert.equal(commands[2]?.[0], "ZREM");
  assert.equal(String(commands[2]?.[1]).includes("principal-redis-1"), false, "owner index must not expose principal IDs");
});

test("Upstash approval store resolves with an atomic pending and action-hash check", async () => {
  const expected = record();
  const commands: unknown[][] = [];
  const store = new UpstashApprovalDecisionStore({
    url: "https://redis.example.com",
    token: "test-token",
    fetchImpl: async (_input, init) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      commands.push(command);
      if (command[0] === "GET") return response(JSON.stringify(expected));
      if (command[0] === "EVAL") return response(1);
      throw new Error("Unexpected Redis command");
    },
  });
  assert.equal(await store.resolve(expected.id, expected.actionHash, "approved", expected.principalId, Date.now()), true);
  const evalCommand = commands[1]!;
  assert.equal(evalCommand[1], APPROVAL_RESOLVE_SCRIPT);
  assert.match(APPROVAL_RESOLVE_SCRIPT, /record\.status ~= 'pending'/u);
  assert.match(APPROVAL_RESOLVE_SCRIPT, /record\.actionHash ~= ARGV\[1\]/u);
  assert.match(APPROVAL_RESOLVE_SCRIPT, /ZREM/u);
});

test("Upstash approval store fails closed and never includes its token in errors", async () => {
  const store = new UpstashApprovalDecisionStore({
    url: "https://redis.example.com",
    token: "super-secret-token",
    fetchImpl: async () => { throw new Error("network failure"); },
  });
  await assert.rejects(store.get("approval-1"), (error: Error) => {
    assert.equal(error.message.includes("super-secret-token"), false);
    return /Approval Redis request failed/u.test(error.message);
  });
});

test("Upstash approval store rejects insecure endpoints and invalid settings", () => {
  const base = { token: "test-token" };
  assert.throws(() => new UpstashApprovalDecisionStore({ ...base, url: "http://redis.example.com" }), /HTTPS/u);
  assert.throws(() => new UpstashApprovalDecisionStore({ ...base, url: "https://user:pass@redis.example.com" }), /HTTPS/u);
  assert.throws(() => new UpstashApprovalDecisionStore({ ...base, url: "https://redis.example.com", prefix: "invalid prefix" }), /prefix/u);
  assert.throws(() => new UpstashApprovalDecisionStore({ ...base, url: "https://redis.example.com", timeoutMs: 10 }), /timeout/u);
});



test("Upstash create atomically caps pending requests and prunes expired index entries", async () => {
  let command: unknown[] = [];
  const store = new UpstashApprovalDecisionStore({
    url: "https://redis.example.com", token: "test-token",
    fetchImpl: async (_input, init) => { command = JSON.parse(String(init?.body)) as unknown[]; return response(-1); },
  });
  await assert.rejects(store.create(record()), /Too many pending approval requests/);
  assert.equal(command[0], "EVAL");
  assert.match(String(command[1]), /ZREMRANGEBYSCORE/u);
  assert.match(String(command[1]), /ZCARD/u);
  assert.equal(command[command.length - 1], "50");
});


test("Upstash atomic resolver script binds approve and deny actors to the stored principal", async () => {
  assert.match(APPROVAL_RESOLVE_SCRIPT, /ARGV\[6\] ~= record\.principalId/u);
  assert.match(APPROVAL_RESOLVE_SCRIPT, /ARGV\[6\] ~= 'system:abort'/u);
  let command: unknown[] = [];
  const store = new UpstashApprovalDecisionStore({
    url: "https://redis.example.com",
    token: "test-token",
    fetchImpl: async (_input, init) => {
      command = JSON.parse(String(init?.body)) as unknown[];
      if (command[0] === "GET") return response(JSON.stringify(record()));
      if (command[0] === "EVAL") return response(0);
      throw new Error("Unexpected Redis command");
    },
  });
  assert.equal(await store.resolve("approval-redis-1", "a".repeat(64), "approved", "attacker", Date.now()), false);
  assert.equal(command[0], "EVAL");
});
