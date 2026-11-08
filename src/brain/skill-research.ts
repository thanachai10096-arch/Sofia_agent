import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { redactSecrets } from "../security/guard.js";
import {
  SkillSelfImprovementLoop,
  type SkillImprovementEvidence,
  type SkillImprovementPlanner,
  type SkillImprovementProposal,
  type SkillSelfImprovementOptions,
} from "./skill-self-improvement.js";
import type { VersionedSkillLifecycle } from "./skill-lifecycle.js";

export interface SkillResearchSource {
  readonly url: string;
  readonly title: string;
  /** Untrusted source excerpt. It is research context, never executable instructions. */
  readonly excerpt: string;
  readonly publishedAt?: string;
}
export interface SkillResearchProvider {
  search(query: string, options: { maxResults: number; signal?: AbortSignal }): Promise<readonly SkillResearchSource[]>;
}
export interface SkillResearchPolicy {
  readonly maxQueries: number;
  readonly maxResultsPerQuery: number;
  readonly maxExcerptLength: number;
  readonly maxTotalCharacters: number;
  readonly allowedDomains?: readonly string[];
}
export interface SkillResearchCitation {
  readonly url: string;
  readonly title: string;
  readonly contentHash: string;
  readonly publishedAt?: string;
}
export interface SkillResearchBundle {
  readonly skillId: string;
  readonly queryCount: number;
  readonly citations: readonly SkillResearchCitation[];
  readonly context: string;
  readonly contextHash: string;
}
export interface SkillResearchAudit {
  readonly bundles: readonly SkillResearchBundle[];
  readonly rejectedSources: number;
}
const DEFAULT_POLICY: SkillResearchPolicy = {
  maxQueries: 3, maxResultsPerQuery: 5, maxExcerptLength: 4000, maxTotalCharacters: 16000,
};

function safeUrl(value: string, allowedDomains?: readonly string[]): URL | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname) !== 0) return undefined;
    if (allowedDomains?.length) {
      const host = url.hostname.toLowerCase();
      if (!allowedDomains.some((domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`))) return undefined;
    }
    // Query strings may carry tracking tokens or credentials; citations use a clean canonical URL.
    url.hash = "";
    url.search = "";
    return url;
  } catch { return undefined; }
}
function validatePolicy(policy: SkillResearchPolicy): void {
  if (!Number.isSafeInteger(policy.maxQueries) || policy.maxQueries < 1 || policy.maxQueries > 10 ||
      !Number.isSafeInteger(policy.maxResultsPerQuery) || policy.maxResultsPerQuery < 1 || policy.maxResultsPerQuery > 10 ||
      !Number.isSafeInteger(policy.maxExcerptLength) || policy.maxExcerptLength < 100 || policy.maxExcerptLength > 8000 ||
      !Number.isSafeInteger(policy.maxTotalCharacters) || policy.maxTotalCharacters < 1000 || policy.maxTotalCharacters > 32000) {
    throw new RangeError("Invalid skill research resource policy");
  }
  if (policy.allowedDomains?.some((domain) => !/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(domain))) {
    throw new TypeError("Invalid skill research domain allowlist");
  }
}
function normalizeExcerpt(value: string, maxLength: number): string {
  // Treat retrieved text as untrusted data. Keep it quoted and bounded so it
  // cannot become an instruction channel to the proposal planner.
  return String(redactSecrets(value)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, maxLength);
}
function queryFor(evidence: SkillImprovementEvidence[]): string {
  // Research queries leave Sofia's trust boundary. Redact secrets from every
  // evidence-derived field before sending anything to an external provider.
  const safeText = (value: string, maxLength: number): string =>
    String(redactSecrets(value))
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, maxLength);
  const skillId = safeText(evidence[0]!.skillId, 160);
  const categories = [...new Set(evidence.map((item) => safeText(item.category, 100)))].slice(0, 4);
  const summaries = safeText(evidence.map((item) => item.summary).join(" "), 1200);
  return `Research reliable technical documentation and safe implementation patterns for Sofia skill ${skillId}; categories: ${categories.join(", ")}; problem evidence: ${summaries}`;
}

/**
 * Adds bounded web research context to a proposal planner. Research is
 * advisory/untrusted: only the caller's pre-existing verified evidence IDs
 * may appear in provenance. No fetched source can independently authorize
 * skill creation, execution, or promotion.
 */
export class ResearchAugmentedSkillPlanner implements SkillImprovementPlanner {
  private readonly policy: SkillResearchPolicy;
  private lastAudit: SkillResearchAudit = { bundles: [], rejectedSources: 0 };
  constructor(
    private readonly researcher: SkillResearchProvider,
    private readonly downstream: (evidence: readonly SkillImprovementEvidence[], research: readonly SkillResearchBundle[]) => Promise<readonly SkillImprovementProposal[]>,
    policy: Partial<SkillResearchPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    validatePolicy(this.policy);
  }
  getAudit(): SkillResearchAudit {
    return {
      bundles: this.lastAudit.bundles.map((bundle) => ({
        ...bundle, citations: bundle.citations.map((citation) => ({ ...citation })),
      })),
      rejectedSources: this.lastAudit.rejectedSources,
    };
  }
  async propose(evidence: readonly SkillImprovementEvidence[]): Promise<readonly SkillImprovementProposal[]> {
    const trusted = evidence.filter((item) => item.verified);
    const groups = new Map<string, SkillImprovementEvidence[]>();
    for (const item of trusted) {
      const group = groups.get(item.skillId) ?? [];
      group.push(item); groups.set(item.skillId, group);
    }
    const bundles: SkillResearchBundle[] = [];
    let rejectedSources = 0;
    for (const [skillId, items] of [...groups.entries()].slice(0, this.policy.maxQueries)) {
      const query = queryFor(items);
      const results = await this.researcher.search(query, {
        maxResults: this.policy.maxResultsPerQuery,
      });
      if (!Array.isArray(results)) throw new TypeError("Research provider must return an array");
      const citations: SkillResearchCitation[] = [];
      const excerpts: string[] = [];
      let remaining = this.policy.maxTotalCharacters;
      for (const source of results.slice(0, this.policy.maxResultsPerQuery)) {
        if (!source || typeof source.url !== "string" || typeof source.title !== "string" ||
            typeof source.excerpt !== "string" || source.title.length > 300 ||
            source.excerpt.length > this.policy.maxExcerptLength * 4) {
          rejectedSources++; continue;
        }
        const url = safeUrl(source.url, this.policy.allowedDomains);
        if (!url) { rejectedSources++; continue; }
        const excerpt = normalizeExcerpt(source.excerpt, Math.min(this.policy.maxExcerptLength, remaining));
        if (!excerpt.trim() || remaining <= 0) { rejectedSources++; continue; }
        const contentHash = createHash("sha256").update(excerpt).digest("hex");
        citations.push({
          url: url.toString(),
          title: String(redactSecrets(source.title)).slice(0, 300),
          contentHash,
          ...(source.publishedAt && Number.isFinite(Date.parse(source.publishedAt))
            ? { publishedAt: source.publishedAt } : {}),
        });
        excerpts.push(`[UNTRUSTED RESEARCH SOURCE: ${url.toString()} | sha256:${contentHash}]\n${excerpt}`);
        remaining -= excerpt.length;
      }
      const context = excerpts.join("\n\n").slice(0, this.policy.maxTotalCharacters);
      bundles.push({
        skillId, queryCount: 1, citations, context,
        contextHash: createHash("sha256").update(context).digest("hex"),
      });
    }
    this.lastAudit = { bundles, rejectedSources };
    const proposals = await this.downstream(trusted, bundles);
    const citationsBySkill = new Map(bundles.map((bundle) => [
      bundle.skillId,
      bundle.citations.map(({ url, contentHash }) => ({ url, contentHash })),
    ]));
    return proposals.map((proposal) => {
      const sources = citationsBySkill.get(proposal.skillPackage.skill.id) ?? [];
      return {
        ...proposal,
        provenance: {
          ...proposal.provenance,
          ...(sources.length > 0 ? { researchSources: sources } : {}),
        },
      };
    });
  }
}

/** Compose internet research with the existing approval- and benchmark-gated lifecycle. */
export function createResearchBackedSkillSelfImprovementLoop(
  lifecycle: VersionedSkillLifecycle,
  researcher: SkillResearchProvider,
  proposeCandidate: (evidence: readonly SkillImprovementEvidence[], research: readonly SkillResearchBundle[]) => Promise<readonly SkillImprovementProposal[]>,
  options: {
    readonly research?: Partial<SkillResearchPolicy>;
    readonly selfImprovement?: Partial<SkillSelfImprovementOptions>;
  } = {},
): SkillSelfImprovementLoop {
  const planner = new ResearchAugmentedSkillPlanner(researcher, proposeCandidate, options.research);
  return new SkillSelfImprovementLoop(lifecycle, planner, options.selfImprovement);
}
