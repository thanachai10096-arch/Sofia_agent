import test from "node:test";
import assert from "node:assert/strict";
import {
  citationBuilder,
  claimEvidenceMapper,
  freshnessChecker,
  registerVerifiedResearchSkills,
  toolArgumentValidator,
  webResearchPlanner,
} from "./research-handlers.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("tool argument validator reuses the registered JSON schema subset", () => {
  const schema = { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false };
  assert.deepEqual(toolArgumentValidator({ schema, arguments: { name: "Sofia" } }), { valid: true, error: null });
  const invalid = toolArgumentValidator({ schema, arguments: { name: 7 } }) as { valid: boolean; error: string };
  assert.equal(invalid.valid, false);
  assert.match(invalid.error, /expected string/);
});

test("tool argument validator rejects malformed schema/input containers", () => {
  assert.throws(() => toolArgumentValidator({ schema: [], arguments: {} }), /schema must be an object/);
  assert.throws(() => toolArgumentValidator({ schema: { type: "object" }, arguments: [] }), /arguments must be an object/);
});

test("web research planner produces bounded queries without claiming fetched sources", () => {
  const result = webResearchPlanner({
    question: "Sofia Agent security architecture",
    domains: ["https://docs.example.com/"],
    sourceCount: 4,
    freshness: "recent",
  }) as { queries: Array<{ query: string }>; fetchedSources: number; executionRequired: boolean; freshness: string };
  assert.ok(result.queries.some(item => item.query.startsWith("site:docs.example.com")));
  assert.equal(result.fetchedSources, 0);
  assert.equal(result.executionRequired, true);
  assert.equal(result.freshness, "recent");
});

test("web research planner bounds source count", () => {
  assert.throws(() => webResearchPlanner({ question: "research", sourceCount: 100 }), /sourceCount/);
});

test("claim evidence mapper ranks lexical overlap and flags weak evidence", () => {
  const result = claimEvidenceMapper({
    claims: [{ id: "claim-1", text: "Sofia supports secure browser automation" }],
    sources: [
      { id: "src-a", title: "Secure browser automation", excerpt: "Sofia supports secure browser automation in isolated sessions." },
      { id: "src-b", title: "Weather report", excerpt: "Forecast and temperature updates." },
    ],
  }) as { mappings: Array<{ matches: Array<{ sourceId: string; score: number }>; needsHumanReview: boolean }>; heuristicOnly: boolean };
  assert.equal(result.mappings[0]?.matches[0]?.sourceId, "src-a");
  assert.ok((result.mappings[0]?.matches[0]?.score ?? 0) > 0.5);
  assert.equal(result.mappings[0]?.needsHumanReview, false);
  assert.equal(result.heuristicOnly, true);
});

test("claim evidence mapper flags claims without matching sources", () => {
  const result = claimEvidenceMapper({
    claims: [{ id: "claim-1", text: "quantum banana protocol" }],
    sources: [{ id: "src-a", title: "Weather", excerpt: "Rain and wind." }],
  }) as { mappings: Array<{ matches: unknown[]; needsHumanReview: boolean }> };
  assert.equal(result.mappings[0]?.matches.length, 0);
  assert.equal(result.mappings[0]?.needsHumanReview, true);
});

test("freshness checker distinguishes fresh, stale, and unknown dates", () => {
  const result = freshnessChecker({
    asOf: "2026-10-17T00:00:00Z",
    maxAgeDays: 365,
    sources: [
      { id: "fresh", publishedAt: "2026-06-01T00:00:00Z" },
      { id: "stale", publishedAt: "2024-01-01T00:00:00Z" },
      { id: "unknown" },
    ],
  }) as { staleCount: number; unknownDateCount: number; sources: Array<{ id: string; freshness: string }> };
  assert.equal(result.staleCount, 1);
  assert.equal(result.unknownDateCount, 1);
  assert.deepEqual(result.sources.map(source => source.freshness), ["fresh", "stale", "unknown"]);
});

test("freshness checker rejects invalid dates and unsafe limits", () => {
  assert.throws(() => freshnessChecker({ asOf: "bad", sources: [] }), /valid date/);
  assert.throws(() => freshnessChecker({ maxAgeDays: 0, sources: [] }), /maxAgeDays/);
});

test("citation builder formats only supplied HTTP(S) sources", () => {
  const result = citationBuilder({
    sources: [{ title: "Official docs [v1]", url: "https://docs.example.com/guide", publishedAt: "2026-01-02" }],
  }) as { citations: string[]; count: number };
  assert.equal(result.count, 1);
  assert.match(result.citations[0] ?? "", /https:\/\/docs\.example\.com\/guide/);
  assert.match(result.citations[0] ?? "", /published 2026-01-02/);
});

test("citation builder rejects unsafe URL schemes", () => {
  assert.throws(() => citationBuilder({ sources: [{ title: "Bad", url: "javascript:alert(1)" }] }), /HTTP or HTTPS/);
});

test("verified research and tool validation skills register through the guarded dispatcher", async () => {
  const registry = new AdvancedSkillRegistry();
  const ids = registerVerifiedResearchSkills(registry);
  assert.deepEqual(ids, ["tools.02", "research.01", "research.03", "research.05", "research.08"]);
  const result = await registry.execute("research.05", {
    asOf: "2026-10-17T00:00:00Z",
    sources: [{ id: "old", publishedAt: "2020-01-01T00:00:00Z" }],
  }, { principalId: "test-user", signal: new AbortController().signal }) as { staleCount: number };
  assert.equal(result.staleCount, 1);
});
