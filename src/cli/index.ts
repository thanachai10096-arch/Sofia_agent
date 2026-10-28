#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SofiaAgent } from "../agent/core.js";
import { createSofiaAgentDependenciesWithSessions } from "../models/factory.js";
import { createNodeWorkspaceRuntime } from "../platform/local-runtime.js";

const args = process.argv.slice(2);
const command = args[0];
const configDir = path.join(os.homedir(), ".sofia");
const configPath = path.join(configDir, "config.json");
const sessionPath = path.join(configDir, "sessions.sqlite");

type LocalConfig = {
  provider?: "openai-compatible" | "gemini" | "openrouter" | "openai" | "xai" | "mistral" | "groq" | "deepseek" | "together" | "fireworks" | "cerebras" | "perplexity" | "ollama";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

async function loadLocalConfig(): Promise<LocalConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const config = parsed as LocalConfig;
    if (!process.env.SOFIA_MODEL_PROVIDER && config.provider) process.env.SOFIA_MODEL_PROVIDER = config.provider;
    if (!process.env.SOFIA_MODEL_BASE_URL && config.baseUrl) process.env.SOFIA_MODEL_BASE_URL = config.baseUrl;
    if (!process.env.SOFIA_MODEL_API_KEY && config.apiKey && config.provider !== "gemini" && config.provider !== "openrouter") process.env.SOFIA_MODEL_API_KEY = config.apiKey;
    if (!process.env.SOFIA_MODEL_NAME && config.model) process.env.SOFIA_MODEL_NAME = config.model;
    if (config.provider === "gemini" && !process.env.GEMINI_API_KEY && config.apiKey) process.env.GEMINI_API_KEY = config.apiKey;
    if (config.provider === "openrouter" && !process.env.OPENROUTER_API_KEY && config.apiKey) process.env.OPENROUTER_API_KEY = config.apiKey;
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}

function help() {
  console.log(`
Sofia Agent CLI

Commands:
  sofia setup             Configure a model provider locally
  sofia chat              Start an interactive local chat (no server required)
  sofia run "<task>"      Run a task directly in the local agent
  sofia init              Initialize Sofia in the current workspace
  sofia status            Show local workspace status

Provider environment:
  SOFIA_MODEL_PROVIDER=openai-compatible|gemini|openrouter
  SOFIA_MODEL_BASE_URL, SOFIA_MODEL_API_KEY, SOFIA_MODEL_NAME
`);
}

async function setup() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const providerAnswer = (await rl.question("Provider [openai-compatible/gemini/openrouter] (openai-compatible): ")).trim().toLowerCase();
    const provider = (providerAnswer || "openai-compatible") as LocalConfig["provider"];
    if (!["openai-compatible", "gemini", "openrouter"].includes(provider ?? "")) {
      throw new Error("Choose openai-compatible, gemini, or openrouter.");
    }
    const baseUrl = provider === "openai-compatible"
      ? (await rl.question("API base URL (for example https://api.openai.com/v1): ")).trim()
      : provider === "openrouter"
        ? ((await rl.question("OpenRouter base URL (default https://openrouter.ai/api/v1): ")).trim() || "https://openrouter.ai/api/v1")
        : "https://generativelanguage.googleapis.com/v1beta/openai/";
    const apiKey = (await rl.question("API key (stored locally with owner-only permissions): ")).trim();
    const model = (await rl.question("Model ID: ")).trim();
    if (!apiKey || !model || !baseUrl) throw new Error("Provider base URL, API key, and model are required.");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const config: LocalConfig = { provider, baseUrl, apiKey, model };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(configPath, 0o600);
    console.log("Saved local provider configuration to ~/.sofia/config.json (owner-only permissions).");
  } finally {
    rl.close();
  }
}

async function runLocal(task: string, interactive: boolean) {
  if (!task.trim()) throw new Error(interactive ? "Enter a message to start chat." : 'Usage: sofia run "your task"');
  const workspace = await createNodeWorkspaceRuntime().cwd();
  const deps = await createSofiaAgentDependenciesWithSessions(workspace, undefined, sessionPath);
  try {
    const agent = new SofiaAgent(deps);
    const result = await agent.run({
      task: task.trim(),
      sessionId: interactive ? "cli:default" : "cli:run",
      principalId: "local-cli",
    });
    console.log(result.output);
  } finally {
    deps.closeSessionStore();
  }
}

async function chat() {
  const workspace = await createNodeWorkspaceRuntime().cwd();
  const deps = await createSofiaAgentDependenciesWithSessions(workspace, undefined, sessionPath);
  const agent = new SofiaAgent(deps);
  const rl = createInterface({ input: stdin, output: stdout });
  console.log("Sofia chat is ready. Type /exit to quit. Sessions are stored locally.");
  try {
    while (true) {
      const input = (await rl.question("you> ")).trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      try {
        const result = await agent.run({ task: input, sessionId: "cli:default", principalId: "local-cli" });
        console.log("sofia> " + result.output);
      } catch (error) {
        console.error("sofia> " + (error instanceof Error ? error.message : "Task failed."));
      }
    }
  } finally {
    rl.close();
    deps.closeSessionStore();
  }
}

async function main() {
  if (!command || command === "help" || command === "--help") return help();
  await loadLocalConfig();

  const runtime = createNodeWorkspaceRuntime();
  if (command === "setup") return setup();
  if (command === "chat") return chat();

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
    console.log(JSON.stringify({
      platform: runtime.platform,
      workspace: await runtime.cwd(),
      localConfig: configPath,
      localSessions: sessionPath,
    }, null, 2));
    return;
  }

  if (command === "run") {
    return runLocal(args.slice(1).join(" "), false);
  }
  return help();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
