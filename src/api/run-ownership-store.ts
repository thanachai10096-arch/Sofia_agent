interface UpstashResponse { result?: unknown; error?: string }

export interface RunOwnershipLease {
  runId: string;
  principalId: string;
  instanceId: string;
  token: string;
  generation: number;
}

export interface RunOwnershipStore {
  claim(input: { runId: string; principalId: string; instanceId: string; token: string; leaseMs: number }): Promise<RunOwnershipLease | undefined>;
  renew(lease: RunOwnershipLease, leaseMs: number): Promise<boolean>;
  assertCurrent(lease: RunOwnershipLease): Promise<boolean>;
  release(lease: RunOwnershipLease): Promise<boolean>;
}

/** Atomic claim. Redis executes the script serially; fencing generations never come from worker clocks. */
export const RUN_OWNERSHIP_CLAIM_SCRIPT = `
local bound = redis.call('GET', KEYS[3])
if bound and bound ~= ARGV[1] then return -1 end
if not bound then
  redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[5], 'NX')
  bound = redis.call('GET', KEYS[3])
  if bound ~= ARGV[1] then return -1 end
end
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local generation = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1],
  'principalId', ARGV[1],
  'instanceId', ARGV[2],
  'token', ARGV[3],
  'generation', tostring(generation))
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return generation
`;

export const RUN_OWNERSHIP_RENEW_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'principalId') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'instanceId') ~= ARGV[2] then return 0 end
if redis.call('HGET', KEYS[1], 'token') ~= ARGV[3] then return 0 end
if redis.call('HGET', KEYS[1], 'generation') ~= ARGV[4] then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
return 1
`;

export const RUN_OWNERSHIP_ASSERT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'principalId') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'instanceId') ~= ARGV[2] then return 0 end
if redis.call('HGET', KEYS[1], 'token') ~= ARGV[3] then return 0 end
if redis.call('HGET', KEYS[1], 'generation') ~= ARGV[4] then return 0 end
return 1
`;

export const RUN_OWNERSHIP_RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'principalId') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'instanceId') ~= ARGV[2] then return 0 end
if redis.call('HGET', KEYS[1], 'token') ~= ARGV[3] then return 0 end
if redis.call('HGET', KEYS[1], 'generation') ~= ARGV[4] then return 0 end
return redis.call('DEL', KEYS[1])
`;

/**
 * Upstash Redis REST lease adapter. Lease expiry is enforced by Redis key TTL,
 * not by comparing application-server clocks. The generation counter and
 * principal binding share the run's Redis Cluster hash slot.
 */
export class UpstashRunOwnershipStore implements RunOwnershipStore {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly prefix: string;
  private readonly bindingTtlMs: number;

  constructor(options: { url: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number; prefix?: string; bindingTtlMs?: number }) {
    let parsed: URL;
    try { parsed = new URL(options.url); } catch { throw new Error("Run ownership Redis URL is invalid."); }
    const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Run ownership Redis URL must use HTTPS without embedded credentials or query parameters.");
    }
    const token = options.token.trim();
    if (!token || token.length > 4096) throw new Error("Run ownership Redis token is invalid.");
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) throw new Error("Run ownership Redis timeout must be between 500 and 30000 milliseconds.");
    const prefix = options.prefix ?? "sofia";
    if (!/^[a-zA-Z0-9:_-]{1,64}$/u.test(prefix)) throw new Error("Run ownership Redis prefix is invalid.");
    const bindingTtlMs = options.bindingTtlMs ?? 30 * 24 * 60 * 60_000;
    if (!Number.isSafeInteger(bindingTtlMs) || bindingTtlMs < 60_000 || bindingTtlMs > 365 * 24 * 60 * 60_000) {
      throw new Error("Run ownership principal binding TTL must be between one minute and 365 days.");
    }
    this.endpoint = parsed.origin + parsed.pathname.replace(/\/+$/u, "");
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
    this.prefix = prefix;
    this.bindingTtlMs = bindingTtlMs;
  }

  private keys(runId: string): [string, string, string] {
    if (!/^[A-Za-z0-9-]{8,64}$/u.test(runId)) throw new Error("Run ownership run ID is invalid.");
    const tag = "{run:" + runId + "}";
    return [this.prefix + ":" + tag + ":lease", this.prefix + ":" + tag + ":fence", this.prefix + ":" + tag + ":principal"];
  }

  private async command(command: Array<string | number>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
        body: JSON.stringify(command),
        signal: controller.signal,
      });
      let payload: UpstashResponse;
      try { payload = await response.json() as UpstashResponse; }
      catch { throw new Error("Run ownership Redis response was not valid JSON."); }
      if (!response.ok || typeof payload.error === "string") throw new Error("Run ownership Redis command failed.");
      return payload.result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Run ownership Redis")) throw error;
      throw new Error("Run ownership Redis request failed.");
    } finally { clearTimeout(timer); }
  }

  private async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.command(["EVAL", script, keys.length, ...keys, ...args]);
  }

  private validateLease(lease: RunOwnershipLease): void {
    if (!lease || typeof lease !== "object") throw new Error("Run ownership lease is invalid.");
    this.keys(lease.runId);
    if (typeof lease.principalId !== "string" || !lease.principalId.trim() ||
        lease.principalId !== lease.principalId.trim() || lease.principalId.length > 256) {
      throw new Error("Run ownership principal ID is invalid.");
    }
    if (typeof lease.instanceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(lease.instanceId)) {
      throw new Error("Run ownership instance ID is invalid.");
    }
    if (typeof lease.token !== "string" || !/^[A-Za-z0-9_-]{16,256}$/u.test(lease.token)) {
      throw new Error("Run ownership token is invalid.");
    }
    if (!Number.isSafeInteger(lease.generation) || lease.generation < 1) {
      throw new Error("Run ownership fencing generation is invalid.");
    }
  }

  async claim(input: { runId: string; principalId: string; instanceId: string; token: string; leaseMs: number }): Promise<RunOwnershipLease | undefined> {
    if (typeof input.principalId !== "string" || !input.principalId.trim() || input.principalId !== input.principalId.trim() || input.principalId.length > 256) throw new Error("Run ownership principal ID is invalid.");
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.instanceId)) throw new Error("Run ownership instance ID is invalid.");
    if (!/^[A-Za-z0-9_-]{16,256}$/u.test(input.token)) throw new Error("Run ownership token is invalid.");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1000 || input.leaseMs > 300_000) throw new Error("Run ownership lease must be between 1000 and 300000 milliseconds.");
    const result = await this.eval(RUN_OWNERSHIP_CLAIM_SCRIPT, this.keys(input.runId), [
      input.principalId, input.instanceId, input.token, String(input.leaseMs), String(this.bindingTtlMs),
    ]);
    if (result === null || result === undefined || Number(result) === 0 || Number(result) === -1) return undefined;
    const generation = Number(result);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Run ownership Redis claim response is invalid.");
    return { runId: input.runId, principalId: input.principalId, instanceId: input.instanceId, token: input.token, generation };
  }

  async renew(lease: RunOwnershipLease, leaseMs: number): Promise<boolean> {
    this.validateLease(lease);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new Error("Run ownership lease must be between 1000 and 300000 milliseconds.");
    const [, , principalKey] = this.keys(lease.runId);
    const result = await this.eval(RUN_OWNERSHIP_RENEW_SCRIPT, [this.keys(lease.runId)[0], principalKey], [
      lease.principalId, lease.instanceId, lease.token, String(lease.generation), String(leaseMs), String(this.bindingTtlMs),
    ]);
    return Number(result) === 1;
  }

  async assertCurrent(lease: RunOwnershipLease): Promise<boolean> {
    this.validateLease(lease);
    const result = await this.eval(RUN_OWNERSHIP_ASSERT_SCRIPT, [this.keys(lease.runId)[0]], [
      lease.principalId, lease.instanceId, lease.token, String(lease.generation),
    ]);
    return Number(result) === 1;
  }

  async release(lease: RunOwnershipLease): Promise<boolean> {
    this.validateLease(lease);
    const result = await this.eval(RUN_OWNERSHIP_RELEASE_SCRIPT, [this.keys(lease.runId)[0]], [
      lease.principalId, lease.instanceId, lease.token, String(lease.generation),
    ]);
    return Number(result) === 1;
  }
}
