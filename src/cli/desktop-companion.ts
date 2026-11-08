import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import { createDesktopCompanionClient } from "../desktop/companion-client.js";
import { FileDesktopCommandJournal } from "../desktop/command-journal.js";
import { createLocalGuiApproval } from "../desktop/gui-approval.js";
import { OsDesktopCredentialStore } from "../desktop/os-credential-store.js";
import { createAllowlistedDesktopHostDriver, parseDesktopApplicationAllowlist, resolveLocalDesktopCapabilities } from "../desktop/local-host.js";
import { createPlatformDesktopHostDriver } from "../desktop/platform-host.js";

async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("This operation requires an interactive local terminal so the API key can be entered without echo.");
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
        if (byte === 3) { cleanup(); reject(new Error("Operation cancelled.")); return; }
        if (byte === 13 || byte === 10) { cleanup(); resolve(value.trim()); return; }
        if (byte === 127 || byte === 8) { value = value.slice(0, -1); continue; }
        if (byte >= 32 && byte <= 126 && value.length < 4096) value += String.fromCharCode(byte);
      }
    };
    input.on("data", onData);
  });
}

async function revokeDesktopCompanion(): Promise<void> {
  const apiBaseUrl = process.env.SOFIA_API_URL;
  if (!apiBaseUrl) throw new Error("Set SOFIA_API_URL to your Sofia server HTTPS URL first.");
  const credentials = new OsDesktopCredentialStore();
  const driver = createAllowlistedDesktopHostDriver({});
  const client = createDesktopCompanionClient({
    apiBaseUrl, credentials, driver, allowedCapabilities: [],
    requestApproval: async () => false,
  });
  let apiKey = await readSecret("Sofia API key (input hidden; used only to revoke pairing): ");
  try {
    await client.disconnect(apiKey);
    console.log("Desktop Companion pairing revoked on Sofia and local credential removed.");
  } finally { apiKey = ""; }
}

export async function runDesktopCompanion(): Promise<void> {
  const apiBaseUrl = process.env.SOFIA_API_URL;
  if (!apiBaseUrl) throw new Error("Set SOFIA_API_URL to your Sofia server HTTPS URL first.");
  const applications = parseDesktopApplicationAllowlist(process.env.SOFIA_DESKTOP_ALLOWED_APPS);
  const credentials = new OsDesktopCredentialStore();
  const allowlistedDriver = createAllowlistedDesktopHostDriver(applications);
  const nativeDriver = createPlatformDesktopHostDriver();
  const driver = { ...nativeDriver, launchApplication: allowlistedDriver.launchApplication };
  const enableInput = process.env.SOFIA_DESKTOP_ENABLE_INPUT?.trim().toLowerCase() === "true";
  const enableScreenCapture = process.env.SOFIA_DESKTOP_ENABLE_SCREEN_CAPTURE?.trim().toLowerCase() === "true";
  const allowedCapabilities = resolveLocalDesktopCapabilities(applications, { enableInput, enableScreenCapture });
  const approval = createLocalGuiApproval();
  const client = createDesktopCompanionClient({
    apiBaseUrl,
    credentials,
    driver,
    journal: new FileDesktopCommandJournal(path.join(homedir(), ".sofia", "desktop-command-journal")),
    allowedCapabilities,
    allowedApplications: Object.keys(applications),
    requestApproval: (action, signal) => approval.requestApproval(action, signal),
    pollIntervalMs: 1500,
  });

  const controller = new AbortController();
  const stop = () => { controller.abort(); client.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!await credentials.get()) {
      let apiKey = await readSecret("Sofia API key (input hidden; used only for initial pairing): ");
      try { await client.pair(apiKey); } finally { apiKey = ""; }
      console.log("Desktop Companion paired. Only the restricted companion token is saved in the OS credential store.");
    } else {
      console.log("Found a saved Sofia Companion token in the OS credential store; attempting to resume pairing.");
    }
    console.log("Allowed applications:", Object.keys(applications).join(", "));
    console.log("GUI approval opens locally in your browser. App launch:", Object.keys(applications).length > 0 ? "enabled for allowlisted apps" : "disabled (no apps allowlisted)");
    console.log("Native input:", enableInput ? "enabled by local operator" : "disabled (set SOFIA_DESKTOP_ENABLE_INPUT=true to enable)");
    console.log("Screen capture:", enableScreenCapture ? "enabled by local operator" : "disabled (set SOFIA_DESKTOP_ENABLE_SCREEN_CAPTURE=true to enable)");
    console.log("Platform driver limitations (e.g. Wayland or missing xdotool/scrot/cliclick) fail closed.");
    console.log("Stop: Ctrl+C (keeps the pairing). Revoke: sofia desktop companion disconnect");
    while (!controller.signal.aborted) {
      try {
        await client.start(controller.signal);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("pairing was revoked") || controller.signal.aborted) throw error;
        console.log("The server no longer recognizes this saved pairing (for example after a server restart). Pair again to continue.");
        let apiKey = await readSecret("Sofia API key (input hidden; used only to re-pair): ");
        try { await client.pair(apiKey); } finally { apiKey = ""; }
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    client.stop();
    await approval.close();
    console.log("Desktop Companion stopped. The OS credential remains saved; use the disconnect command to revoke and remove it.");
  }
}

export async function disconnectDesktopCompanion(): Promise<void> {
  await revokeDesktopCompanion();
}
