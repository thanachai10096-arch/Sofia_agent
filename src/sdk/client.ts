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

export interface SofiaRunResponse {
  id: string;
  status: "completed" | "failed";
  result?: { output: string; kind: string; steps: number };
  error?: string;
}

export class SofiaClient {
  constructor(private readonly options: SofiaClientOptions) {}

  async run(input: SofiaRunInput): Promise<SofiaRunResponse> {
    const response = await fetch(new URL("/v1/agent/runs", this.options.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });

    const data = await response.json() as SofiaRunResponse;
    if (!response.ok) throw new Error(data.error ?? `Sofia API error ${response.status}`);
    return data;
  }
}
