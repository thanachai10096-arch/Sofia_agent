export interface SofiaClientOptions {
  apiKey: string;
  baseUrl: string;
}

export interface SofiaRunInput {
  task: string;
  workspace?: string;
  context?: Record<string, unknown>;
  maxSteps?: number;
}

export type SofiaRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SofiaRunResponse {
  id: string;
  status: SofiaRunStatus;
  result?: { output: string; kind: string; steps: number };
  error?: string;
}

export class SofiaClient {
  constructor(private readonly options: SofiaClientOptions) {}

  private url(path: string) {
    return new URL(path, this.options.baseUrl);
  }

  private headers() {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json",
    };
  }

  async run(input: SofiaRunInput): Promise<SofiaRunResponse> {
    const response = await fetch(this.url("/v1/agent/runs"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    const data = await response.json() as SofiaRunResponse;
    if (!response.ok) throw new Error(data.error ?? `Sofia API error ${response.status}`);
    return data;
  }

  /**
   * Mobile-safe run: returns immediately, survives app backgrounding/network
   * changes, and can be polled until Sofia completes.
   */
  async start(input: SofiaRunInput): Promise<SofiaRunResponse> {
    const response = await fetch(this.url("/v1/agent/runs"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...input, async: true }),
    });
    const data = await response.json() as SofiaRunResponse;
    if (!response.ok && response.status !== 202) {
      throw new Error(data.error ?? `Sofia API error ${response.status}`);
    }
    return data;
  }

  async getRun(id: string): Promise<SofiaRunResponse> {
    const response = await fetch(this.url(`/v1/agent/runs/${encodeURIComponent(id)}`), {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
    });
    const data = await response.json() as SofiaRunResponse;
    if (!response.ok) throw new Error(data.error ?? `Sofia API error ${response.status}`);
    return data;
  }

  async cancel(id: string): Promise<SofiaRunResponse> {
    const response = await fetch(this.url(`/v1/agent/runs/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
    });
    const data = await response.json() as SofiaRunResponse;
    if (!response.ok) throw new Error(data.error ?? `Sofia API error ${response.status}`);
    return data;
  }

  async waitForRun(id: string, options: { intervalMs?: number; timeoutMs?: number } = {}) {
    const intervalMs = options.intervalMs ?? 1000;
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const run = await this.getRun(id);
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error("Timed out waiting for Sofia run.");
  }
}
