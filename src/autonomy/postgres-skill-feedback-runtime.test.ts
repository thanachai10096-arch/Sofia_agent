import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresSkillFeedbackHostConfig } from "./postgres-skill-feedback-runtime.js";

test("Postgres skill feedback bootstrap initializes both durable stores", async () => {
    const statements: string[] = [];
    const pool = {
      async query(sql: string) { statements.push(sql); return { rows: [] }; },
      async connect() { throw new Error("connect should not be needed during schema setup"); },
    };
    const resolveScope = (principalId: string) => "tenant:" + principalId;
    const resolveSafetyIncidentCount = () => 0;
    const config = await createPostgresSkillFeedbackHostConfig({
      pool,
      resolveScope,
      resolveSafetyIncidentCount,
    });

    assert.equal(statements.length, 2);
    assert.match(statements[0]!, /sofia_skill_registry/);
    assert.match(statements[1]!, /sofia_skill_feedback/);
    assert.ok(config.registry);
    assert.ok(config.ledger);
    assert.equal(config.resolveScope, resolveScope);
    assert.equal(config.resolveSafetyIncidentCount, resolveSafetyIncidentCount);
});

test("Postgres skill feedback bootstrap fails closed when host dependencies are missing", async () => {
    await assert.rejects(createPostgresSkillFeedbackHostConfig({
      pool: undefined as never,
      resolveScope: () => "tenant:test",
      resolveSafetyIncidentCount: () => 0,
    }), /Trusted PostgreSQL pool and host identity\/safety resolvers are required\./);
});

test("Postgres skill feedback bootstrap rejects partial schema initialization", async () => {
    let calls = 0;
    const pool = {
      async query() {
        calls += 1;
        if (calls === 2) throw new Error("database unavailable");
        return { rows: [] };
      },
      async connect() { throw new Error("not used"); },
    };
    await assert.rejects(createPostgresSkillFeedbackHostConfig({
      pool,
      resolveScope: () => "tenant:test",
      resolveSafetyIncidentCount: () => 0,
    }), /database unavailable/);
    assert.equal(calls, 2);
});
