import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const MODEL_KEYS = new Set([
  "SOFIA_MODEL_PROVIDER", "SOFIA_MODEL_BASE_URL", "SOFIA_MODEL_API_KEY", "SOFIA_MODEL",
]);

async function ask(question: string, defaultValue = ""): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue ? " [" + defaultValue + "]" : "";
    return (await rl.question(question + suffix + ": ")).trim() || defaultValue;
  } finally { rl.close(); }
}

async function askSecret(): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Run sofia setup in an interactive terminal so the API key can be entered without echo.");
  }
  stdout.write("API key (input hidden): ");
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      const input = chunk.toString("utf8");
      for (const char of input) {
        if (char === "\u0003") { finish(new Error("Setup cancelled.")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          stdout.write("\b \b");
        } else if (char >= " " && char !== "\u007f") {
          value += char;
          stdout.write("*");
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Configure a compatible provider without printing or committing credentials. */
export async function runSetupWizard(workspace = process.cwd()): Promise<void> {
  stdout.write("\nSofia Agent setup — model provider\n");
  stdout.write("Use Gemini, OpenAI, OpenRouter, a compatible cloud endpoint, or a local OpenAI-compatible server.\n");
  const provider = await ask("Provider label (informational)", "custom");
  const baseUrl = await ask("OpenAI-compatible API base URL", GEMINI_BASE_URL);
  const model = await ask("Model ID", "gemini-2.5-flash");
  const apiKey = await askSecret();
  if (!apiKey) throw new Error("API key cannot be empty.");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(provider)) {
    throw new Error("Provider label must start with a letter and contain only letters, numbers, _ or -.");
  }
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("API base URL is invalid."); }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Use an HTTPS base URL (HTTP is allowed only for localhost) without credentials, query, or fragment.");
  }
  if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error("Model ID is invalid.");
  if (/[\r\n]/.test(apiKey)) throw new Error("API key is invalid.");

  const envPath = path.join(workspace, ".env");
  mkdirSync(workspace, { recursive: true });
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const retained = existing.split(/\r?\n/).filter((line) => {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !MODEL_KEYS.has(match[1]!);
  }).filter((line, index, all) => line.length > 0 || index < all.length - 1);
  const additions = [
    "# Sofia model provider configuration — keep this file private.",
    "SOFIA_MODEL_PROVIDER=" + JSON.stringify(provider),
    "SOFIA_MODEL_BASE_URL=" + JSON.stringify(parsed.toString().replace(/\/+$/, "") + "/"),
    "SOFIA_MODEL_API_KEY=" + JSON.stringify(apiKey),
    "SOFIA_MODEL=" + JSON.stringify(model),
  ];
  const content = [...retained, ...additions].join("\n").replace(/\n*$/, "\n");
  writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(envPath, 0o600); } catch { /* some platforms do not support POSIX permissions */ }
  stdout.write("\nSaved provider settings to .env with owner-only permissions where supported.\n");
  stdout.write("The API key was not printed. Keep .env out of source control and configure deployment secrets separately.\n");
}
