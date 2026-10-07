import type { BrainRunInput } from "../brain/executor.js";
import type { JobRecord, JobRuntime } from "../brain/job-runtime.js";

export interface CloudExecutionBackend {
  readonly id: string;
  submit(input: Omit<BrainRunInput, "signal" | "resume">): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | undefined>;
  cancel(jobId: string): Promise<boolean>;
}

export class LocalJobBackend implements CloudExecutionBackend {
  readonly id = "local";
  constructor(private readonly jobs: JobRuntime) {}
  submit(input: Omit<BrainRunInput, "signal" | "resume">) { return this.jobs.submit(input); }
  get(jobId: string) { return this.jobs.get(jobId); }
  cancel(jobId: string) { return this.jobs.cancel(jobId); }
}
