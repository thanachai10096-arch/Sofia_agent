#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SofiaAgent } from "../agent/core.js";
import { createSofiaAgentDependenciesWithSessions } from "../models/factory.js";
import { createNodeWorkspaceRuntime } from "../platform/local-runtime.js";
import { createCliSessionId } from "./session-id.js";
import { assertNoLegacyPlaintextApiKey, writeSafeLocalConfig } from "./config-file.js";

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
    const configStat = await lstat(configPath);
    if (!configStat.isFile() || configStat.isSymbolicLink()) {
      throw new Error("Sofia config must be a regular file, not a symbolic link.");
    }
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
  SOFIA_MODEL_PROVIDER, SOFIA_MODEL_BASE_URL, SOFIA_MODEL_NAME
  API keys: provider-specific variables (for example OPENAI_API_KEY,
  GEMINI_API_KEY, OPENROUTER_API_KEY) or SOFIA_MODEL_API_KEY for
  OpenAI-compatible endpoints. Keys are never written by "sofia setup".
`);
}

async function setup() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const providerOptions = [
      "openai-compatible", "gemini", "openai", "openrouter", "xai", "mistral",
      "groq", "deepseek", "together", "fireworks", "cerebras", "perplexity", "ollama",
    ] as const;
    const providerAnswer = (await rl.question(`Provider [${providerOptions.join("/")}] (openai-compatible): `)).trim().toLowerCase();
    const provider = (providerAnswer || "openai-compatible") as LocalConfig["provider"];
    if (!providerOptions.includes(provider as typeof providerOptions[number])) {
      throw new Error("Choose one of the listed providers. For other compatible APIs, choose openai-compatible.");
    }
    const presetBaseUrls: Partial<Record<NonNullable<LocalConfig["provider"]>, string>> = {
      gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
      openai: "https://api.openai.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
      xai: "https://api.x.ai/v1",
      mistral: "https://api.mistral.ai/v1",
      groq: "https://api.groq.com/openai/v1",
      deepseek: "https://api.deepseek.com/v1",
      together: "https://api.together.xyz/v1",
      fireworks: "https://api.fireworks.ai/inference/v1",
      cerebras: "https://api.cerebras.ai/v1",
      perplexity: "https://api.perplexity.ai",
      ollama: "http://127.0.0.1:11434/v1",
    };
    const baseUrl = provider === "openai-compatible"
      ? (await rl.question("API base URL (HTTPS; loopback HTTP is allowed for local servers): ")).trim()
      : presetBaseUrls[provider!];
    const defaultModel = provider === "gemini" ? "gemini-2.5-flash"
      : provider === "openai" ? "gpt-4.1-mini"
      : provider === "openrouter" ? "openai/gpt-4.1-mini"
      : provider === "ollama" ? "llama3.2" : "";
    const model = (await rl.question(`Model ID${defaultModel ? ` (default ${defaultModel})` : ""}: `)).trim() || defaultModel;
    if (!model || !baseUrl) {
      throw new Error("Provider base URL and model are required.");
    }
    const keyEnv: Partial<Record<NonNullable<LocalConfig["provider"]>, string>> = {
      gemini: "GEMINI_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      xai: "XAI_API_KEY",
      mistral: "MISTRAL_API_KEY",
      groq: "GROQ_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      together: "TOGETHER_API_KEY",
      fireworks: "FIREWORKS_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      perplexity: "PERPLEXITY_API_KEY",
    };
    const requiredKeyEnv = keyEnv[provider] ?? "SOFIA_MODEL_API_KEY";
    // Never replace a legacy config until its only stored credential has been moved safely.
    await assertNoLegacyPlaintextApiKey(configPath, requiredKeyEnv);
    if (provider !== "ollama" && !process.env[requiredKeyEnv]?.trim()) {
      console.log(`\nSet ${requiredKeyEnv} in your shell environment before starting Sofia. The setup wizard never asks for or writes API keys.`);
    }
    await writeSafeLocalConfig(configPath, { provider, baseUrl, model });
    console.log("Saved provider, endpoint, and model configuration to ~/.sofia/config.json (owner-only permissions).");
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
      sessionId: createCliSessionId(interactive),
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
  if (command === "setup") return setup();
  await loadLocalConfig();

  const runtime = createNodeWorkspaceRuntime();
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
