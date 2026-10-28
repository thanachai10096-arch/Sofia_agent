#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SofiaClient } from "../sdk/client.js";
import { createNodeWorkspaceRuntime } from "../platform/local-runtime.js";
import {
  assessHostedSetup,
  checkHostedSofiaApi,
  createHostedSetupConfig,
  validateSofiaApiBaseUrl,
  type HostedSetupConfig,
} from "../setup/wizard.js";

const args = process.argv.slice(2);
const command = args[0];
const SETUP_DIRECTORY = path.join(os.homedir(), ".sofia");
const SETUP_CONFIG_PATH = path.join(SETUP_DIRECTORY, "setup.json");

function help() {
  console.log(`
Sofia Agent CLI

Commands:
  sofia setup
  sofia check
  sofia init
  sofia run "<task>"
  sofia status

Environment:
  SOFIA_API_KEY   API key for Sofia (required by sofia run; never saved by setup)
  SOFIA_API_URL   API base URL (overrides the saved setup URL)
`);
}

async function loadSetupConfig(): Promise<HostedSetupConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(SETUP_CONFIG_PATH, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Sofia setup file is invalid JSON. Inspect or move it aside before rerunning 'sofia setup'.");
  }

  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("mode" in value) ||
    value.mode !== "hosted" ||
    !("apiBaseUrl" in value) ||
    typeof value.apiBaseUrl !== "string"
  ) {
    throw new Error("Sofia setup file has an unsupported format. Inspect or move it aside before rerunning setup.");
  }

  return createHostedSetupConfig(value.apiBaseUrl);
}

async function saveSetupConfig(config: HostedSetupConfig): Promise<void> {
  await mkdir(SETUP_DIRECTORY, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(SETUP_DIRECTORY, 0o700);

  const tempPath = path.join(SETUP_DIRECTORY, `setup.json.tmp-${process.pid}`);
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (process.platform !== "win32") await chmod(tempPath, 0o600);
    await rename(tempPath, SETUP_CONFIG_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown filesystem error";
    throw new Error(`Could not save Sofia setup securely (${message}). Existing setup was not intentionally removed.`);
  }
}

async function runSetupWizard(): Promise<void> {
  const current = await loadSetupConfig();
  const initialUrl =
    process.env.SOFIA_API_URL?.trim() ||
    current?.apiBaseUrl ||
    "http://localhost:3000";

  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    console.log("\nSofia Agent Setup");
    console.log("This wizard configures a connection to a hosted or already-running Sofia API.");
    console.log("It does not configure a local model provider and does not save API keys.\n");

    const enteredUrl = await terminal.question(`Sofia API base URL [${initialUrl}]: `);
    const config = createHostedSetupConfig(enteredUrl.trim() || initialUrl);
    const readiness = assessHostedSetup({
      apiBaseUrl: config.apiBaseUrl,
      hasApiKey: Boolean(process.env.SOFIA_API_KEY?.trim()),
    });

    await saveSetupConfig(config);
    console.log(`\nSaved non-secret setup configuration to ${SETUP_CONFIG_PATH}`);
    console.log("Checklist:");
    for (const step of readiness.steps) {
      console.log(`- [${step.status.toUpperCase()}] ${step.title}: ${step.description}`);
    }
    console.log("\nNext steps:");
    if (!process.env.SOFIA_API_KEY?.trim()) {
      console.log("- Set SOFIA_API_KEY in your shell or secret manager; Sofia never stores this value in setup.json.");
    }
    console.log('- Run "sofia run \\"your task\\"" when the API key is configured.');
    console.log("- The wizard has not made a live connection request; the API endpoint and credentials are not yet verified.");
  } finally {
    terminal.close();
  }
}

async function main() {
  if (!command || command === "help" || command === "--help") return help();

  if (command === "setup") {
    await runSetupWizard();
    return;
  }

  if (command === "check") {
    const setup = await loadSetupConfig();
    const apiKey = process.env.SOFIA_API_KEY ?? "";
    const baseUrl = validateSofiaApiBaseUrl(
      process.env.SOFIA_API_URL ?? setup?.apiBaseUrl ?? "http://localhost:3000",
    );
    const result = await checkHostedSofiaApi({ apiBaseUrl: baseUrl, apiKey });
    console.log(JSON.stringify(result, null, 2));
    if (!result.reachable || !result.authenticated) process.exitCode = 1;
    return;
  }

  const runtime = createNodeWorkspaceRuntime();
  if (command === "init") {
    await runtime.writeFile(".sofia/config.json", JSON.stringify({
      version: 1,
      platform: runtime.platform,
      workspace: await runtime.cwd(),
    }, null, 2));
    console.log(`Sofia initialized for ${runtime.platform}.`);
    return;
  }

  if (command === "status") {
    const setup = await loadSetupConfig();
    console.log(JSON.stringify({
      platform: runtime.platform,
      workspace: await runtime.cwd(),
      setup: setup ? { mode: setup.mode, apiBaseUrl: setup.apiBaseUrl } : "not configured",
      apiKeyAvailable: Boolean(process.env.SOFIA_API_KEY?.trim()),
    }, null, 2));
    return;
  }

  if (command === "run") {
    const task = args.slice(1).join(" ").trim();
    if (!task) throw new Error('Usage: sofia run "your task"');
    const apiKey = process.env.SOFIA_API_KEY;
    if (!apiKey) throw new Error('SOFIA_API_KEY is required. Run "sofia setup" and configure the key in your shell or secret manager.');
    const savedSetup = await loadSetupConfig();
    const baseUrl = validateSofiaApiBaseUrl(
      process.env.SOFIA_API_URL ?? savedSetup?.apiBaseUrl ?? "http://localhost:3000",
    );
    const client = new SofiaClient({
      apiKey,
      baseUrl,
    });
    const result = await client.run({ task, workspace: await runtime.cwd() });
    console.log(result.result?.output ?? result.error ?? "No output");
    return;
  }

  help();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Sofia CLI failed.");
  process.exitCode = 1;
});
