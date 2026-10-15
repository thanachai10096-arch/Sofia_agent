#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
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
  sofia chat [title]            Start an interactive conversation
  sofia chat --resume <id>      Resume a saved conversation
  sofia status

Environment:
  SOFIA_API_KEY   API key for Sofia
  SOFIA_API_URL   API base URL (default: http://localhost:3000)
`);
}

function createClient(): SofiaClient {
  const apiKey = process.env.SOFIA_API_KEY;
  if (!apiKey) throw new Error("SOFIA_API_KEY is required.");
  return new SofiaClient({
    apiKey,
    baseUrl: process.env.SOFIA_API_URL ?? "http://localhost:3000",
  });
}

async function chat(client: SofiaClient, chatArgs: string[]): Promise<void> {
  const resumeIndex = chatArgs.indexOf("--resume");
  let conversation;
  if (resumeIndex >= 0) {
    const id = chatArgs[resumeIndex + 1]?.trim();
    if (!id) throw new Error("Usage: sofia chat --resume <conversation-id>");
    conversation = await client.getConversation(id);
  } else {
    const title = chatArgs.join(" ").trim() || "Sofia conversation";
    conversation = await client.createConversation(title);
  }

  console.log(`Sofia conversation: ${conversation.title}`);
  console.log(`Conversation ID: ${conversation.id}`);
  console.log("Type /exit to leave, /clear to clear history, or /help for commands.\n");
  if (conversation.messages.length) {
    for (const message of conversation.messages) {
      if (message.role === "user" || message.role === "assistant") {
        console.log(`${message.role === "user" ? "You" : "Sofia"}: ${message.content}\n`);
      }
    }
  }

  const terminal = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    while (true) {
      let input: string;
      try {
        input = (await terminal.question("You: ")).trim();
      } catch {
        console.log("\nLeaving conversation. Your saved history is preserved.");
        break;
      }
      if (!input) continue;
      if (input === "/exit" || input === "/quit") {
        console.log("Conversation saved.");
        break;
      }
      if (input === "/help") {
        console.log("Commands: /exit, /quit, /clear, /help");
        continue;
      }
      if (input === "/clear") {
        conversation = await client.clearConversation(conversation.id);
        console.log("Conversation history cleared.\n");
        continue;
      }

      try {
        const accepted = await client.sendConversationMessage(conversation.id, input, { async: true });
        if (!("pollUrl" in accepted)) {
          console.log(`Sofia: ${accepted.assistantMessage.content || "(No text response)"}\n`);
          continue;
        }
        console.log("Sofia is thinking…");
        const turn = await client.waitForConversationTurn(conversation.id, accepted.run.id, {
          timeoutMs: 30 * 60 * 1000,
        });
        if (turn.status === "completed") {
          console.log(`Sofia: ${turn.assistantMessage?.content ?? turn.result?.output ?? "(No text response)"}\n`);
        } else {
          console.error(`Sofia ${turn.status}: ${turn.error ?? "No error details provided."}\n`);
        }
      } catch (error) {
        console.error(`Could not complete this turn: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    terminal.close();
  }
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
    const task = args.slice(1).join(" ").trim();
    if (!task) throw new Error("Usage: sofia run \"your task\"");
    const result = await createClient().run({ task, workspace: await runtime.cwd() });
    console.log(result.result?.output ?? result.error ?? "No output");
    return;
  }

  if (command === "chat") {
    await chat(createClient(), args.slice(1));
    return;
  }

  help();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
