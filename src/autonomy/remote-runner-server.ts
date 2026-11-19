import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Sandbox } from "../sandbox.js";

const MAX_FILES = 10_000;
const DEFAULT_SNAPSHOT_BYTES = 100 * 1024 * 1024;

export interface RemoteSandboxRunnerOptions {
  /** Secret-manager token used by Sofia's RemoteSandbox client. */
  token: string;
  /** Must be a real container-isolated runner, never ProcessSandbox. */
  sandbox: Sandbox;
  tempRoot?: string;
  maxConcurrentRuns?: number;
  maxRequestBytes?: number;
  maxSnapshotBytes?: number;
  maxTimeoutMs?: number;
  /** Explicit operator policy. Networking is disabled unless this is true. */
  allowNetwork?: boolean;
  /** Operator attestation that host firewall blocks private, link-local and metadata destinations. */
  publicInternetEgressEnforced?: boolean;
  /** Host-owned provisioner that creates each workspace on a hard quota-limited filesystem. */
  workspaceProvisioner?: {
    createWorkspace(): Promise<string>;
    disposeWorkspace(workspacePath: string): Promise<void>;
  };
}

interface RequestFile { path: string; contentBase64: string; }
interface ExecuteRequest {
  protocolVersion: number;
  requestId: string;
  workspaceDigest: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  allowNetwork: boolean;
  files: RequestFile[];
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > limit) throw Object.assign(new Error("Request body exceeds the configured limit."), { statusCode: 413 });
    chunks.push(data);
  }
  return Buffer.concat(chunks, size);
}

function validateRequest(value: unknown, options: Required<Pick<RemoteSandboxRunnerOptions,
  "maxSnapshotBytes" | "maxTimeoutMs">>): ExecuteRequest {
  if (!isRecord(value) ||
      Object.keys(value).some((key) => !["protocolVersion", "requestId", "workspaceDigest", "command", "args", "cwd", "timeoutMs", "maxOutputBytes", "allowNetwork", "files"].includes(key)) ||
      value.protocolVersion !== 1 ||
      typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId) ||
      typeof value.workspaceDigest !== "string" || !/^[a-f0-9]{64}$/i.test(value.workspaceDigest) ||
      typeof value.command !== "string" || !value.command.trim() || value.command.includes("\0") ||
      !Array.isArray(value.args) || value.args.length > 128 ||
      value.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      typeof value.cwd !== "string" || value.cwd.includes("\0") || typeof value.timeoutMs !== "number" ||
      !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > options.maxTimeoutMs ||
      typeof value.maxOutputBytes !== "number" || !Number.isSafeInteger(value.maxOutputBytes) ||
      value.maxOutputBytes < 1 || value.maxOutputBytes > 10 * 1024 * 1024 ||
      typeof value.allowNetwork !== "boolean" || !Array.isArray(value.files) ||
      value.files.length > MAX_FILES) {
    throw Object.assign(new Error("Invalid remote sandbox request."), { statusCode: 400 });
  }
  const cwd = path.posix.normalize(value.cwd);
  if (cwd !== value.cwd || cwd === ".." || cwd.startsWith("../") || path.posix.isAbsolute(cwd) || cwd.includes("\\")) {
    throw Object.assign(new Error("Invalid sandbox working directory."), { statusCode: 400 });
  }
  let total = 0;
  const paths = new Set<string>();
  const files: RequestFile[] = [];
  for (const item of value.files) {
    if (!isRecord(item) ||
        Object.keys(item).some((key) => key !== "path" && key !== "contentBase64") ||
        typeof item.path !== "string" || typeof item.contentBase64 !== "string" ||
        item.path.includes("\0") || item.path.includes("\\")) {
      throw Object.assign(new Error("Invalid project snapshot file."), { statusCode: 400 });
    }
    const normalized = path.posix.normalize(item.path);
    if (normalized !== item.path || normalized === "." || normalized === ".." ||
        normalized.startsWith("../") || path.posix.isAbsolute(normalized) || paths.has(normalized)) {
      throw Object.assign(new Error("Invalid or duplicate project snapshot path."), { statusCode: 400 });
    }
    const data = Buffer.from(item.contentBase64, "base64");
    if (data.toString("base64") !== item.contentBase64 || data.length > options.maxSnapshotBytes - total) {
      throw Object.assign(new Error("Invalid or oversized project snapshot content."), { statusCode: 413 });
    }
    total += data.length;
    paths.add(normalized);
    files.push({ path: normalized, contentBase64: item.contentBase64 });
  }
  const snapshotHash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    snapshotHash.update(file.path).update("\0").update(file.contentBase64).update("\0");
  }
  if (snapshotHash.digest("hex") !== value.workspaceDigest) {
    throw Object.assign(new Error("Project snapshot digest mismatch."), { statusCode: 400 });
  }
  return {
    protocolVersion: 1,
    requestId: value.requestId,
    workspaceDigest: value.workspaceDigest,
    command: value.command,
    args: value.args as string[],
    cwd,
    timeoutMs: value.timeoutMs,
    maxOutputBytes: value.maxOutputBytes,
    allowNetwork: value.allowNetwork,
    files,
  };
}

async function stageFiles(root: string, files: RequestFile[]): Promise<Map<string, string>> {
  const originals = new Map<string, string>();
  for (const file of files) {
    const destination = path.resolve(root, ...file.path.split("/"));
    const relative = path.relative(root, destination);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("Snapshot path escaped runner workspace.");
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const data = Buffer.from(file.contentBase64, "base64");
    const handle = await open(destination, "wx", 0o600);
    try { await handle.writeFile(data); } finally { await handle.close(); }
    originals.set(file.path, destination);
  }
  return originals;
}

async function collectFiles(originals: Map<string, string>, workspaceRoot: string, maxBytes: number): Promise<RequestFile[]> {
  const output: RequestFile[] = [];
  let total = 0;
  for (const [relative, filename] of originals) {
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      // A malicious command can replace an ancestor directory with a symlink.
      // Resolve the full path and prove it remains under this run's disposable root.
      const resolved = await realpath(filename);
      const withinRoot = path.relative(workspaceRoot, resolved);
      if (!withinRoot || withinRoot === ".." || withinRoot.startsWith(".." + path.sep) || path.isAbsolute(withinRoot)) {
        throw new Error("Runner output path escaped its disposable workspace.");
      }
      const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size > maxBytes - total) {
          throw new Error("Runner output snapshot exceeded its size limit.");
        }
        const data = await handle.readFile();
        if (data.length > maxBytes - total) throw new Error("Runner output snapshot exceeded its size limit.");
        total += data.length;
        output.push({ path: relative, contentBase64: data.toString("base64") });
      } finally { await handle.close(); }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return output;
}

/** Creates the authenticated HTTP API consumed by Sofia's RemoteSandbox client. */
export function createRemoteSandboxRunnerServer(options: RemoteSandboxRunnerOptions): Server {
  if (typeof options.token !== "string" || options.token.length < 32 || /[\r\n]/.test(options.token)) {
    throw new Error("Remote sandbox runner token must contain at least 32 characters.");
  }
  if (options.sandbox.isolation !== "container") {
    throw new Error("Remote sandbox runner requires a container-isolated sandbox.");
  }
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 2;
  const maxRequestBytes = options.maxRequestBytes ?? 140 * 1024 * 1024;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_SNAPSHOT_BYTES;
  const maxTimeoutMs = options.maxTimeoutMs ?? 300_000;
  for (const [name, value] of Object.entries({ maxConcurrentRuns, maxRequestBytes, maxSnapshotBytes, maxTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + " must be a positive safe integer.");
  }
  const allowNetwork = options.allowNetwork === true;
  if (allowNetwork && options.publicInternetEgressEnforced !== true) {
    throw new Error("Networked runner requires an operator-confirmed public-internet-only egress firewall.");
  }
  if (!options.workspaceProvisioner ||
      typeof options.workspaceProvisioner.createWorkspace !== "function" ||
      typeof options.workspaceProvisioner.disposeWorkspace !== "function") {
    throw new Error("Remote runner requires a host-owned workspace provisioner backed by a hard per-run disk quota.");
  }
  let activeRuns = 0;
  const tempRoot = path.resolve(options.tempRoot ?? path.join(os.tmpdir(), "sofia-remote-runner"));

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { status: "ok", protocolVersion: 1 });
      return;
    }
    if (request.method === "GET" && request.url === "/readyz") {
      try {
        if (!options.sandbox.healthCheck) throw new Error("Runner readiness probe is unavailable.");
        await options.sandbox.healthCheck();
        json(response, 200, { status: "ready", protocolVersion: 1 });
      } catch {
        json(response, 503, { status: "not_ready", protocolVersion: 1 });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/sandbox/execute") {
      json(response, 404, { error: "not_found" });
      return;
    }
    const authorizationHeader = request.headers.authorization;
    const authorization = typeof authorizationHeader === "string" ? authorizationHeader : "";
    if (!authorization.startsWith("Bearer ") || !safeEqual(authorization.slice(7), options.token)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (activeRuns >= maxConcurrentRuns) {
      json(response, 429, { error: "runner_busy" });
      return;
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      json(response, 415, { error: "unsupported_media_type" });
      return;
    }
    activeRuns += 1;
    const abortController = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) abortController.abort();
    });
    let workspace: string | undefined;
    try {
      const raw = await readBody(request, maxRequestBytes);
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      const job = validateRequest(parsed, { maxSnapshotBytes, maxTimeoutMs });
      if (request.headers["x-sofia-request-id"] !== job.requestId) {
        json(response, 400, { error: "request_id_mismatch" });
        return;
      }
      if (job.allowNetwork && !allowNetwork) {
        json(response, 403, { error: "network_disabled_by_runner_policy" });
        return;
      }
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      const trustedTempRoot = await realpath(tempRoot);
      workspace = await options.workspaceProvisioner!.createWorkspace();
      const trustedWorkspace = await realpath(workspace);
      const workspaceParent = path.dirname(trustedWorkspace);
      const workspaceInfo = await lstat(trustedWorkspace);
      if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() ||
          trustedWorkspace === trustedTempRoot || workspaceParent !== trustedTempRoot) {
        throw new Error("Workspace provisioner must return a fresh direct child of the configured runner temp root.");
      }
      workspace = trustedWorkspace;
      const originalFiles = await stageFiles(workspace, job.files);
      const workingDirectory = path.resolve(workspace, ...job.cwd.split("/").filter((part) => part && part !== "."));
      const relativeCwd = path.relative(workspace, workingDirectory);
      if (relativeCwd === ".." || relativeCwd.startsWith(".." + path.sep) || path.isAbsolute(relativeCwd)) {
        json(response, 400, { error: "invalid_working_directory" });
        return;
      }
      await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
      const result = await options.sandbox.run(job.command, job.args, {
        timeoutMs: job.timeoutMs,
        maxOutputBytes: job.maxOutputBytes,
        allowNetwork: job.allowNetwork && allowNetwork,
        workspaceRoot: workspace,
        cwd: relativeCwd || undefined,
      }, abortController.signal);
      const files = await collectFiles(originalFiles, workspace, maxSnapshotBytes);
      const outputBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      if (outputBytes > job.maxOutputBytes) throw new Error("Sandbox runner output exceeded its limit.");
      json(response, 200, {
        protocolVersion: 1,
        requestId: job.requestId,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        files,
      });
    } catch (error) {
      const status = isRecord(error) && typeof error.statusCode === "number"
        ? error.statusCode
        : error instanceof SyntaxError ? 400 : 500;
      if (!response.headersSent && !response.destroyed) {
        json(response, status, { error: status === 413 ? "payload_too_large" : "invalid_or_failed_request" });
      }
    } finally {
      if (workspace) await options.workspaceProvisioner!.disposeWorkspace(workspace).catch(() => undefined);
      activeRuns -= 1;
    }
  });
  // Bound slow headers and request bodies so unauthenticated clients cannot
  // hold runner connections indefinitely while consuming scarce sockets.
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  return server;
}
