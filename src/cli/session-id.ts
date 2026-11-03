import { randomUUID } from "node:crypto";

/**
 * Keep the interactive chat transcript stable while isolating every one-shot run.
 * An optional id is accepted to make the mapping deterministic in tests.
 */
export function createCliSessionId(interactive: boolean, runId = randomUUID()): string {
  return interactive ? "cli:default" : `cli:run:${runId}`;
}
