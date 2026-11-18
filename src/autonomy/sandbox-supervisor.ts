import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AutonomyContext } from "./controller.js";
import type { Sandbox, SandboxLimits } from "../sandbox.js";

export interface SandboxSupervisorBudget {
  maxCycles: number;
  maxSteps: number;
  maxToolCallsPerStep: number;
  maxExperimentSeconds: number;
  maxSpendUsd: number;
  maxOutputBytes: number;
}

export interface SandboxSupervisorOptions {
  /** Host-owned root; never accept this path from model-generated tool input. */
  workspaceRoot: string;
  /** Secret from a secret manager, never from a user/model request. */
  attestationSecret: string;
  sandbox: Sandbox;
  budget: SandboxSupervisorBudget;
  /** Network stays disabled unless the host explicitly opts in for this run. */
  allowNetwork?: boolean;
}

export interface SandboxRunIdentity {
  principalId: string;
  runId: string;
}

export interface SandboxAttestation {
  principalDigest: string;
  runDigest: string;
  workspaceDigest: string;
  isolation: "container";
  issuedAt: number;
  signature: string;
}

interface ActiveRun {
  identity: SandboxRunIdentity;
  workspace: string;
  cycles: number;
  steps: number;
  toolCalls: number;
  experimentSeconds: number;
  estimatedSpendUsd: number;
  active: boolean;
  attestation: SandboxAttestation;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sign(secret: string, payload: Omit<SandboxAttestation, "signature">): string {
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Owns per-principal/per-run workspace roots and issues verifiable attestations
 * only while a container-backed run is active. It deliberately does not copy
 * arbitrary host repositories into the workspace or grant access to secrets.
 */
export class SandboxSupervisor {
  private readonly root: string;
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly options: SandboxSupervisorOptions) {
    if (options.sandbox.isolation !== "container") {
      throw new Error("SandboxSupervisor requires a container-isolated Sandbox implementation.");
    }
    if (typeof options.attestationSecret !== "string" || options.attestationSecret.length < 32) {
      throw new Error("Sandbox attestation secret must contain at least 32 characters.");
    }
    const b = options.budget;
    if (!validPositiveInteger(b.maxCycles) || !validPositiveInteger(b.maxSteps) ||
        !validPositiveInteger(b.maxToolCallsPerStep) || !validPositiveInteger(b.maxExperimentSeconds) ||
        !Number.isFinite(b.maxSpendUsd) || b.maxSpendUsd < 0 ||
        !validPositiveInteger(b.maxOutputBytes)) {
      throw new Error("Sandbox supervisor budget is invalid.");
    }
    this.root = path.resolve(options.workspaceRoot);
  }

  private key(identity: SandboxRunIdentity): string {
    if (!identity || typeof identity.principalId !== "string" || !identity.principalId.trim() ||
        typeof identity.runId !== "string" || !identity.runId.trim()) {
      throw new Error("Authenticated principal and run identity are required.");
    }
    return digest(identity.principalId) + ":" + digest(identity.runId);
  }

  async beginRun(identity: SandboxRunIdentity): Promise<SandboxAttestation> {
    const key = this.key(identity);
    if (this.runs.has(key)) throw new Error("Sandbox run already exists.");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const trustedRoot = await realpath(this.root);
    const principalDir = path.join(trustedRoot, digest(identity.principalId));
    const runDir = path.join(principalDir, digest(identity.runId));
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const workspace = await realpath(runDir);
    const relative = path.relative(trustedRoot, workspace);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("Sandbox workspace escaped the supervisor root.");
    }
    const payload = {
      principalDigest: digest(identity.principalId),
      runDigest: digest(identity.runId),
      workspaceDigest: digest(workspace),
      isolation: "container" as const,
      issuedAt: Date.now(),
    };
    const attestation = { ...payload, signature: sign(this.options.attestationSecret, payload) };
    this.runs.set(key, {
      identity: { principalId: identity.principalId, runId: identity.runId },
      workspace,
      cycles: 0,
      steps: 0,
      toolCalls: 0,
      experimentSeconds: 0,
      estimatedSpendUsd: 0,
      active: true,
      attestation,
    });
    return structuredClone(attestation);
  }

  verifyAttestation(identity: SandboxRunIdentity, attestation: SandboxAttestation): boolean {
    try {
      const run = this.runs.get(this.key(identity));
      if (!run?.active || !attestation || typeof attestation !== "object") return false;
      const { signature, ...payload } = attestation;
      const expected = sign(this.options.attestationSecret, payload);
      const supplied = Buffer.from(typeof signature === "string" ? signature : "", "hex");
      const wanted = Buffer.from(expected, "hex");
      return supplied.length === wanted.length && timingSafeEqual(supplied, wanted) &&
        payload.principalDigest === digest(identity.principalId) &&
        payload.runDigest === digest(identity.runId) &&
        payload.workspaceDigest === digest(run.workspace) &&
        payload.isolation === "container" &&
        payload.issuedAt === run.attestation.issuedAt;
    } catch {
      return false;
    }
  }

  async run(
    identity: SandboxRunIdentity,
    attestation: SandboxAttestation,
    command: string,
    args: string[],
    request: { timeoutMs: number; maxOutputBytes?: number; cwd?: string; allowNetwork?: boolean },
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number; durationMs: number }> {
    const key = this.key(identity);
    const run = this.runs.get(key);
    if (!run?.active || !this.verifyAttestation(identity, attestation)) {
      throw new Error("A valid active sandbox attestation is required.");
    }
    if (!validPositiveInteger(request.timeoutMs) || request.timeoutMs > this.options.budget.maxExperimentSeconds * 1000) {
      throw new Error("Sandbox command timeout exceeds the autonomy budget.");
    }
    if (run.steps >= this.options.budget.maxSteps || run.toolCalls >= this.options.budget.maxToolCallsPerStep) {
      throw new Error("Sandbox step or tool-call budget exhausted.");
    }
    if (request.allowNetwork === true && this.options.allowNetwork !== true) {
      throw new Error("Sandbox network access is not authorized by the host.");
    }
    const maxOutputBytes = request.maxOutputBytes ?? this.options.budget.maxOutputBytes;
    if (!validPositiveInteger(maxOutputBytes) || maxOutputBytes > this.options.budget.maxOutputBytes) {
      throw new Error("Sandbox output limit exceeds the configured budget.");
    }

    run.steps += 1;
    run.toolCalls += 1;
    const started = Date.now();
    const result = await this.options.sandbox.run(command, args, {
      timeoutMs: request.timeoutMs,
      maxOutputBytes,
      allowNetwork: request.allowNetwork === true,
      workspaceRoot: run.workspace,
      ...(request.cwd ? { cwd: request.cwd } : {}),
    }, signal);
    const durationMs = Date.now() - started;
    run.experimentSeconds += durationMs / 1000;
    if (run.experimentSeconds > this.options.budget.maxExperimentSeconds) {
      run.active = false;
      throw new Error("Sandbox cumulative experiment-time budget exhausted.");
    }
    return { ...result, durationMs };
  }

  /** Call only with cost telemetry from the trusted model/provider billing layer. */
  recordSpend(identity: SandboxRunIdentity, attestation: SandboxAttestation, spendUsd: number): void {
    const run = this.runs.get(this.key(identity));
    if (!run?.active || !this.verifyAttestation(identity, attestation) ||
        !Number.isFinite(spendUsd) || spendUsd < 0) {
      throw new Error("Trusted spend telemetry or active sandbox attestation is invalid.");
    }
    run.estimatedSpendUsd += spendUsd;
    if (run.estimatedSpendUsd > this.options.budget.maxSpendUsd) {
      run.active = false;
      throw new Error("Sandbox autonomy spend budget exhausted.");
    }
  }

  /** Returns trusted, live measurements for the autonomy policy adapter. */
  getAutonomyContext(identity: SandboxRunIdentity, attestation: SandboxAttestation): AutonomyContext {
    const run = this.runs.get(this.key(identity));
    if (!run?.active || !this.verifyAttestation(identity, attestation)) {
      return { sandboxAvailable: false };
    }
    return {
      sandboxAvailable: true,
      remainingCycles: Math.max(0, this.options.budget.maxCycles - run.cycles),
      remainingSteps: Math.max(0, this.options.budget.maxSteps - run.steps),
      remainingToolCalls: Math.max(0, this.options.budget.maxToolCallsPerStep - run.toolCalls),
      experimentSeconds: Math.max(0, this.options.budget.maxExperimentSeconds - run.experimentSeconds),
      estimatedSpendUsd: run.estimatedSpendUsd,
    };
  }

  recordCycle(identity: SandboxRunIdentity, attestation: SandboxAttestation): void {
    const run = this.runs.get(this.key(identity));
    if (!run?.active || !this.verifyAttestation(identity, attestation)) {
      throw new Error("A valid active sandbox attestation is required.");
    }
    run.cycles += 1;
    if (run.cycles > this.options.budget.maxCycles) {
      run.active = false;
      throw new Error("Sandbox autonomy cycle budget exhausted.");
    }
  }

  endRun(identity: SandboxRunIdentity): void {
    const run = this.runs.get(this.key(identity));
    if (run) run.active = false;
  }
}
