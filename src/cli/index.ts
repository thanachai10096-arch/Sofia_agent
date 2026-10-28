#!/usr/bin/env node
import { SofiaClient } from "../sdk/client.js";
import { createNodeWorkspaceRuntime } from "../platform/local-runtime.js";

const args = process.argv.slice(2);
const command = args[0];

function help() {
  console.log(`
Sofia Agent CLI

Commands:
  sofia init
  sofia run "<task>"
  sofia status

Environment:
  SOFIA_API_KEY   API key for Sofia
  SOFIA_API_URL   API base URL (default: http://localhost:3000)
`);
}

async function main() {
  if (!command || command === "help" || command === "--help") return help();

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
    console.log(JSON.stringify({
      platform: runtime.platform,
      workspace: await runtime.cwd(),
    }, null, 2));
    return;
  }

  if (command === "run") {
    const runArgs = args.slice(1);
    let modelSelection: "auto" | "fast" | "coding" | "reasoning" | "vision" | undefined;
    const modelFlag = runArgs.indexOf("--model");
    if (modelFlag >= 0) {
      const selected = runArgs[modelFlag + 1];
      if (!["auto", "fast", "coding", "reasoning", "vision"].includes(selected ?? "")) {
        throw new Error("Usage: sofia run [--model auto|fast|coding|reasoning|vision] \"your task\"");
      }
      modelSelection = selected as typeof modelSelection;
      runArgs.splice(modelFlag, 2);
    }
    const task = runArgs.join(" ").trim();
    if (!task) throw new Error("Usage: sofia run [--model auto|fast|coding|reasoning|vision] \"your task\"");
    const apiKey = process.env.SOFIA_API_KEY;
    if (!apiKey) throw new Error("SOFIA_API_KEY is required.");
    const client = new SofiaClient({
      apiKey,
      baseUrl: process.env.SOFIA_API_URL ?? "http://localhost:3000",
    });
    const result = await client.run({ task, workspace: await runtime.cwd(), ...(modelSelection ? { modelSelection } : {}) });
    console.log(result.result?.output ?? result.error ?? "No output");
    return;
  }

  help();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
