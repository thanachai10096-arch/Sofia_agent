import { SofiaClient } from "../dist/src/sdk/client.js";

const apiKey = process.env.SOFIA_API_KEY;
const baseUrl = process.env.SOFIA_API_BASE_URL;
if (!apiKey) throw new Error("Missing SOFIA_API_KEY Actions secret.");
if (!baseUrl) throw new Error("Missing SOFIA_API_BASE_URL Actions variable.");

const client = new SofiaClient({ apiKey, baseUrl, requestTimeoutMs: 45_000 });
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("Live agent E2E timed out.")), 5 * 60_000);

try {
  const started = await client.start({
    task: "This is a safe Sofia live E2E connectivity check. Reply with exactly this token and no other text: SOFIA_LIVE_AGENT_OK",
    maxSteps: 3,
  }, controller.signal);

  if (!started.id) throw new Error("Sofia API did not return a run ID.");
  const result = await client.waitForRun(started.id, {
    intervalMs: 1_000,
    maxIntervalMs: 5_000,
    timeoutMs: 4 * 60_000,
    signal: controller.signal,
  });

  if (result.status !== "completed") {
    throw new Error(`Sofia run ended with status: ${result.status}; error: ${result.error ?? "none"}`);
  }
  const output = result.result?.output ?? "";
  if (!output.includes("SOFIA_LIVE_AGENT_OK")) {
    throw new Error("Sofia completed the run but did not return the required live E2E token.");
  }

  console.log("Live Sofia API/agent E2E passed.");
  console.log(`Run ID: ${result.id}`);
  console.log(`Status: ${result.status}; steps: ${result.result?.steps ?? "unknown"}`);
  console.log("Output content and credentials are intentionally not logged.");
} finally {
  clearTimeout(timeout);
}
