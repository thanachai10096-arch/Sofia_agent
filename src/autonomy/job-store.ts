import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sofiaStateDirectory } from "../platform/state-directory.js";

export type AutonomyJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AutonomyJob<TPayload = unknown, TResult = unknown> {
  version: 1;
  id: string;
  principalId: string;
  kind: "research";
  status: AutonomyJobStatus;
  payload: TPayload;
  result?: TResult;
  error?: string;
  idempotencyKey?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  availableAt: string;
  lease?: { workerId: string; expiresAt: string };
}

export interface EnqueueAutonomyJob<TPayload = unknown> {
  principalId: string;
  kind: "research";
  payload: TPayload;
  idempotencyKey?: string;
  maxAttempts?: number;
  availableAt?: string;
}

export interface AutonomyJobStore {
  enqueue<TPayload>(input: EnqueueAutonomyJob<TPayload>): Promise<AutonomyJob<TPayload>>;
  get<TPayload = unknown, TResult = unknown>(principalId: string, jobId: string): Promise<AutonomyJob<TPayload, TResult> | undefined>;
  list<TPayload = unknown>(principalId: string): Promise<AutonomyJob<TPayload>[]>;
  claimNext<TPayload = unknown>(workerId: string, leaseMs: number): Promise<AutonomyJob<TPayload> | undefined>;
  heartbeat(principalId: string, jobId: string, workerId: string, leaseMs: number): Promise<AutonomyJob>;
  complete<TResult>(principalId: string, jobId: string, workerId: string, result: TResult): Promise<AutonomyJob<unknown, TResult>>;
  fail(principalId: string, jobId: string, workerId: string, error: string, retryable: boolean): Promise<AutonomyJob>;
  cancel(principalId: string, jobId: string): Promise<AutonomyJob>;
  recoverExpired(now?: Date): Promise<number>;
}

const queues = new Map<string, Promise<void>>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const terminal = (status: AutonomyJobStatus) => status === "completed" || status === "failed" || status === "cancelled";

function validPrincipal(principalId: string): string {
  const value = principalId.trim();
  if (!value) throw new Error("Authenticated principal identity is required.");
  return value;
}

function validateJob(value: unknown): value is AutonomyJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<AutonomyJob>;
  return job.version === 1 && typeof job.id === "string" &&
    typeof job.principalId === "string" && job.principalId.length > 0 && job.kind === "research" &&
    ["queued", "running", "completed", "failed", "cancelled"].includes(String(job.status)) &&
    Number.isSafeInteger(job.attempts) && Number.isSafeInteger(job.maxAttempts) &&
    typeof job.createdAt === "string" && typeof job.updatedAt === "string" &&
    typeof job.availableAt === "string";
}

/**
 * Durable local queue for a single active worker/process. Use a transactional
 * database-backed AutonomyJobStore for multiple Railway replicas or workers:
 * filesystem rename is atomic but is not a distributed claim/lock primitive.
 */
export class FileAutonomyJobStore implements AutonomyJobStore {
  private readonly directory: string;

  constructor(namespace: string, root = sofiaStateDirectory("autonomy-jobs")) {
    if (!namespace.trim()) throw new Error("A non-empty job-store namespace is required.");
    this.directory = path.join(root, hash(namespace));
  }

  private file(jobId: string): string {
    return path.join(this.directory, hash(jobId) + ".json");
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.directory) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    queues.set(this.directory, tail);
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (queues.get(this.directory) === tail) queues.delete(this.directory);
    }
  }

  private async write(job: AutonomyJob): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const target = this.file(job.id);
    const temporary = target + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(job), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async readFile<TPayload = unknown, TResult = unknown>(jobId: string): Promise<AutonomyJob<TPayload, TResult> | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file(jobId), "utf8"));
      if (!validateJob(parsed)) throw new Error("Autonomy job record is malformed.");
      return parsed as AutonomyJob<TPayload, TResult>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async all(): Promise<AutonomyJob[]> {
    let names: string[];
    try { names = await fs.readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const jobs: AutonomyJob[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const raw: unknown = JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8"));
      if (!validateJob(raw)) throw new Error("Autonomy job record is malformed.");
      jobs.push(raw);
    }
    return jobs;
  }

  async enqueue<TPayload>(input: EnqueueAutonomyJob<TPayload>): Promise<AutonomyJob<TPayload>> {
    const principalId = validPrincipal(input.principalId);
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new Error("Autonomy job maxAttempts must be between 1 and 10.");
    }
    if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) {
      throw new Error("Idempotency key cannot be empty.");
    }
    return this.serialize(async () => {
      const existing = (await this.all()).find((job) =>
        job.principalId === principalId && job.idempotencyKey === input.idempotencyKey &&
        input.idempotencyKey !== undefined,
      );
      if (existing) return existing as AutonomyJob<TPayload>;
      const now = new Date().toISOString();
      const job: AutonomyJob<TPayload> = {
        version: 1, id: randomUUID(), principalId, kind: input.kind,
        status: "queued", payload: input.payload,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        attempts: 0, maxAttempts, createdAt: now, updatedAt: now,
        availableAt: input.availableAt ?? now,
      };
      await this.write(job);
      return job;
    });
  }

  async get<TPayload = unknown, TResult = unknown>(principalId: string, jobId: string): Promise<AutonomyJob<TPayload, TResult> | undefined> {
    const job = await this.readFile<TPayload, TResult>(jobId);
    return job?.principalId === validPrincipal(principalId) ? job : undefined;
  }

  async list<TPayload = unknown>(principalId: string): Promise<AutonomyJob<TPayload>[]> {
    const owner = validPrincipal(principalId);
    return (await this.all()).filter((job) => job.principalId === owner) as AutonomyJob<TPayload>[];
  }

  async claimNext<TPayload = unknown>(workerId: string, leaseMs: number): Promise<AutonomyJob<TPayload> | undefined> {
    if (!workerId.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) {
      throw new Error("Worker identity and a lease between 1s and 5m are required.");
    }
    return this.serialize(async () => {
      const now = Date.now();
      const job = (await this.all())
        .filter((item) => item.status === "queued" && Date.parse(item.availableAt) <= now)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return undefined;
      job.status = "running";
      job.attempts += 1;
      job.updatedAt = new Date(now).toISOString();
      job.lease = { workerId, expiresAt: new Date(now + leaseMs).toISOString() };
      await this.write(job);
      return job as AutonomyJob<TPayload>;
    });
  }

  private async owned(principalId: string, jobId: string, workerId: string): Promise<AutonomyJob> {
    const job = await this.readFile(jobId);
    if (!job || job.principalId !== validPrincipal(principalId)) throw new Error("Autonomy job not found.");
    if (job.status !== "running" || job.lease?.workerId !== workerId) throw new Error("Worker does not own the active job lease.");
    if (Date.parse(job.lease.expiresAt) <= Date.now()) throw new Error("Autonomy job lease has expired.");
    return job;
  }

  async heartbeat(principalId: string, jobId: string, workerId: string, leaseMs: number): Promise<AutonomyJob> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new Error("Invalid job lease duration.");
    return this.serialize(async () => {
      const job = await this.owned(principalId, jobId, workerId);
      job.lease!.expiresAt = new Date(Date.now() + leaseMs).toISOString();
      job.updatedAt = new Date().toISOString();
      await this.write(job);
      return job;
    });
  }

  async complete<TResult>(principalId: string, jobId: string, workerId: string, result: TResult): Promise<AutonomyJob<unknown, TResult>> {
    return this.serialize(async () => {
      const job = await this.owned(principalId, jobId, workerId);
      job.status = "completed";
      job.result = result;
      delete job.lease;
      job.updatedAt = new Date().toISOString();
      await this.write(job);
      return job as AutonomyJob<unknown, TResult>;
    });
  }

  async fail(principalId: string, jobId: string, workerId: string, error: string, retryable: boolean): Promise<AutonomyJob> {
    return this.serialize(async () => {
      const job = await this.owned(principalId, jobId, workerId);
      job.error = error.slice(0, 1000);
      delete job.lease;
      job.status = retryable && job.attempts < job.maxAttempts ? "queued" : "failed";
      job.updatedAt = new Date().toISOString();
      job.availableAt = job.updatedAt;
      await this.write(job);
      return job;
    });
  }

  async cancel(principalId: string, jobId: string): Promise<AutonomyJob> {
    return this.serialize(async () => {
      const job = await this.readFile(jobId);
      if (!job || job.principalId !== validPrincipal(principalId)) throw new Error("Autonomy job not found.");
      if (terminal(job.status)) return job;
      job.status = "cancelled";
      delete job.lease;
      job.updatedAt = new Date().toISOString();
      await this.write(job);
      return job;
    });
  }

  async recoverExpired(now = new Date()): Promise<number> {
    return this.serialize(async () => {
      let recovered = 0;
      for (const job of await this.all()) {
        if (job.status !== "running" || !job.lease || Date.parse(job.lease.expiresAt) > now.getTime()) continue;
        delete job.lease;
        job.status = job.attempts < job.maxAttempts ? "queued" : "failed";
        job.error = "Worker lease expired; job recovered after interruption.";
        job.updatedAt = now.toISOString();
        job.availableAt = now.toISOString();
        await this.write(job);
        recovered += 1;
      }
      return recovered;
    });
  }
}
