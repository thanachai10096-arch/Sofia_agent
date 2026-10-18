import test from "node:test";
import assert from "node:assert/strict";
import { decideComputeBackend } from "../src/platform/compute-policy.js";
import type { ComputeRoutingInput } from "../src/platform/compute-policy.js";

const readyRemote: ComputeRoutingInput = {
  localAvailable: false,
  remoteConfigured: true,
  remoteHealthy: true,
  remoteAuthenticated: true,
  remoteIsolated: true,
};

test("auto mode prefers local compute when available", () => {
  const result = decideComputeBackend({ ...readyRemote, localAvailable: true });
  assert.equal(result.backend, "local");
  assert.equal(result.localFallbackAllowed, true);
});

test("auto mode uses remote only when local is unavailable and remote passes every gate", () => {
  const result = decideComputeBackend(readyRemote);
  assert.equal(result.backend, "remote");
  assert.equal(result.localFallbackAllowed, false);
});

test("auto mode does not use an unauthenticated or unisolated remote backend", () => {
  const unauthenticated = decideComputeBackend({ ...readyRemote, localAvailable: true, remoteAuthenticated: false });
  assert.equal(unauthenticated.backend, "local");
  assert.match(unauthenticated.reason, /authentication/);

  const unisolated = decideComputeBackend({ ...readyRemote, localAvailable: true, remoteIsolated: false });
  assert.equal(unisolated.backend, "local");
  assert.match(unisolated.reason, /isolation/);
});

test("remote tasks containing secrets or requiring local resources are not routed remotely", () => {
  const secretTask = decideComputeBackend({ ...readyRemote, localAvailable: true, task: { containsSecrets: true } });
  assert.equal(secretTask.backend, "local");
  assert.match(secretTask.reason, /contains secrets/);

  const localTask = decideComputeBackend({ ...readyRemote, localAvailable: true, task: { requiresLocalResources: true } });
  assert.equal(localTask.backend, "local");
  assert.match(localTask.reason, /local-only/);
});

test("remote network and memory requirements are checked explicitly", () => {
  const network = decideComputeBackend({
    ...readyRemote,
    localAvailable: true,
    task: { requiresNetwork: true },
    remoteNetworkAllowed: false,
  });
  assert.equal(network.backend, "local");
  assert.match(network.reason, /network access/);

  const memory = decideComputeBackend({
    ...readyRemote,
    localAvailable: true,
    task: { estimatedMemoryMb: 2048 },
    maxRemoteMemoryMb: 1024,
  });
  assert.equal(memory.backend, "local");
  assert.match(memory.reason, /memory/);
});

test("explicit local preference stays local even when remote is ready", () => {
  const result = decideComputeBackend({ ...readyRemote, preference: "local" });
  assert.equal(result.backend, "local");
  assert.equal(result.reason, "local backend explicitly requested");
});

test("explicit remote preference fails closed when readiness gates fail", () => {
  const result = decideComputeBackend({
    ...readyRemote,
    preference: "remote",
    remoteAuthenticated: false,
  });
  assert.equal(result.backend, "unavailable");
  assert.equal(result.localFallbackAllowed, false);
  assert.match(result.reason, /remote request rejected/);
});
