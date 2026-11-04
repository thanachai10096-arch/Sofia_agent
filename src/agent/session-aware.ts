import type { AgentDependencies, AgentRequest, AgentResult } from "./types.js";
import { SofiaAgent } from "./core.js";
import { buildSessionContext } from "../session/context.js";

/**
 * Opt-in facade that replays a bounded, fenced transcript into the next turn.
 * Use this when durable session storage is configured. The regular SofiaAgent
 * API remains unchanged for backwards compatibility.
 */
export class SessionAwareSofiaAgent {
  private readonly agent: SofiaAgent;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: AgentDependencies) {
    this.agent = new SofiaAgent(dependencies);
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const sessionId = request.sessionId;
    const store = this.dependencies.sessionStore;
    if (!sessionId || !store) return this.agent.run(request);

    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      // Read before SofiaAgent appends the current user turn.
      const priorMessages = [...store.getOrCreate(sessionId).messages];
      const context = buildSessionContext(priorMessages, request.context);
      return await this.agent.run({ ...request, ...(context ? { context } : {}) });
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }
}
