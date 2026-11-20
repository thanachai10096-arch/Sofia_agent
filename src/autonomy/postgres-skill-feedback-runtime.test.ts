import { describe, expect, it } from "vitest";
import { createPostgresSkillFeedbackHostConfig } from "./postgres-skill-feedback-runtime.js";

describe("createPostgresSkillFeedbackHostConfig", () => {
  it("initializes both durable stores before returning the Brain host config", async () => {
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

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("sofia_skill_registry");
    expect(statements[1]).toContain("sofia_skill_feedback");
    expect(config.registry).toBeDefined();
    expect(config.ledger).toBeDefined();
    expect(config.resolveScope).toBe(resolveScope);
    expect(config.resolveSafetyIncidentCount).toBe(resolveSafetyIncidentCount);
  });

  it("fails closed when a trusted host dependency is missing", async () => {
    await expect(createPostgresSkillFeedbackHostConfig({
      pool: undefined as never,
      resolveScope: () => "tenant:test",
      resolveSafetyIncidentCount: () => 0,
    })).rejects.toThrow("Trusted PostgreSQL pool and host identity/safety resolvers are required.");
  });

  it("does not return a partially initialized host config when schema setup fails", async () => {
    let calls = 0;
    const pool = {
      async query() {
        calls += 1;
        if (calls === 2) throw new Error("database unavailable");
        return { rows: [] };
      },
      async connect() { throw new Error("not used"); },
    };
    await expect(createPostgresSkillFeedbackHostConfig({
      pool,
      resolveScope: () => "tenant:test",
      resolveSafetyIncidentCount: () => 0,
    })).rejects.toThrow("database unavailable");
    expect(calls).toBe(2);
  });
});
