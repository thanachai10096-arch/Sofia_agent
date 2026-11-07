import { createInterface } from "node:readline";
import { createDesktopCompanionClient, type DesktopCompanionCredentialStore } from "../desktop/companion-client.js";
import { createAllowlistedDesktopHostDriver, describeDesktopAction, parseDesktopApplicationAllowlist } from "../desktop/local-host.js";

class MemoryCredentialStore implements DesktopCompanionCredentialStore {
  private token: string | null = null;
  async get() { return this.token; }
  async set(token: string) { this.token = token; }
  async delete() { this.token = null; }
}

async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Desktop pairing requires an interactive local terminal so the API key can be entered without echo.");
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      output.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Pairing cancelled."));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32 && byte <= 126 && value.length < 4096) value += String.fromCharCode(byte);
      }
    };
    input.on("data", onData);
  });
}

export async function runDesktopCompanion(): Promise<void> {
  const apiBaseUrl = process.env.SOFIA_API_URL;
  if (!apiBaseUrl) throw new Error("Set SOFIA_API_URL to your Sofia server HTTPS URL first.");
  const applications = parseDesktopApplicationAllowlist(process.env.SOFIA_DESKTOP_ALLOWED_APPS);
  if (Object.keys(applications).length === 0) {
    throw new Error("No local apps are allowlisted. Set SOFIA_DESKTOP_ALLOWED_APPS to a JSON object of app IDs and absolute executable paths.");
  }
  const credentials = new MemoryCredentialStore();
  const driver = createAllowlistedDesktopHostDriver(applications);
  const client = createDesktopCompanionClient({
    apiBaseUrl,
    credentials,
    driver,
    allowedCapabilities: ["app:launch"],
    allowedApplications: Object.keys(applications),
    requestApproval: async (action) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log("\nSofia requests a local desktop action:");
        console.log(describeDesktopAction(action));
        const answer = await rl.question("Approve this action on this computer? Type YES to allow: ");
        return answer.trim() === "YES";
      } finally {
        rl.close();
      }
    },
    pollIntervalMs: 1500,
  });

  const apiKey = await readSecret("Sofia API key (input hidden; key is not saved): ");
  if (!apiKey) throw new Error("A Sofia API key is required to pair this computer.");
  await client.pair(apiKey);
  // Drop the only local reference to the master key immediately after pairing.
  console.log("Desktop Companion paired. Only the short-lived companion token remains in memory.");
  console.log("Allowed applications:", Object.keys(applications).join(", "));
  console.log("This initial host supports app launch only; screen/mouse/keyboard controls remain disabled.");
  console.log("Press Ctrl+C to disconnect.");

  const controller = new AbortController();
  const stop = () => { controller.abort(); client.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await client.start(controller.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await credentials.delete();
    console.log("Desktop Companion disconnected; in-memory pairing token cleared.");
  }
}
