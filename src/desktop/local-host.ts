import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { DesktopAction, DesktopHostDriver } from "./types.js";

export type DesktopApplicationAllowlist = Readonly<Record<string, string>>;

/** Parse a strict application-id -> absolute executable-path map supplied by the local operator. */
export function parseDesktopApplicationAllowlist(raw: string | undefined): DesktopApplicationAllowlist {
  if (!raw?.trim()) return Object.freeze({});
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("SOFIA_DESKTOP_ALLOWED_APPS must be a JSON object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SOFIA_DESKTOP_ALLOWED_APPS must be a JSON object.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new Error("At most 32 desktop applications may be allowlisted.");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, executable] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || typeof executable !== "string" ||
        !path.isAbsolute(executable) || executable.length > 1024 || executable.includes("\0")) {
      throw new Error("Desktop application entries require a short ID and an absolute executable path.");
    }
    const canonical = realpathSync(executable);
    const executableName = path.basename(canonical).toLowerCase();
    const blockedLaunchers = new Set([
      "sh", "bash", "zsh", "dash", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe",
      "pwsh", "pwsh.exe", "wscript", "wscript.exe", "cscript", "cscript.exe", "node", "node.exe",
      "python", "python.exe", "python3", "ruby", "perl", "php", "osascript", "expect", "busybox",
    ]);
    if (blockedLaunchers.has(executableName)) {
      throw new Error("General-purpose command interpreters cannot be allowlisted as desktop applications.");
    }
    const info = statSync(canonical);
    const macApplicationBundle = process.platform === "darwin" && canonical.toLowerCase().endsWith(".app") &&
      info.isDirectory() && statSync(path.join(canonical, "Contents", "Info.plist")).isFile();
    if (!info.isFile() && !macApplicationBundle) {
      throw new Error("Allowlisted desktop application must be an executable file or a valid macOS .app bundle: " + id);
    }
    if (process.platform !== "win32" && !macApplicationBundle) accessSync(canonical, constants.X_OK);
    result[id] = canonical;
  }
  return Object.freeze(result);
}

/**
 * A deliberately narrow first local host: it can launch only explicitly
 * allowlisted executables. Input control and screen capture stay unavailable
 * until a platform-native, separately reviewed driver is installed.
 */
export function createAllowlistedDesktopHostDriver(
  applications: DesktopApplicationAllowlist,
): DesktopHostDriver {
  return {
    async captureScreen() {
      throw new Error("Screen capture is not enabled in the initial local companion host.");
    },
    async click() {
      throw new Error("Mouse control is not enabled in the initial local companion host.");
    },
    async typeText() {
      throw new Error("Keyboard text control is not enabled in the initial local companion host.");
    },
    async pressKey() {
      throw new Error("Keyboard control is not enabled in the initial local companion host.");
    },
    async launchApplication(applicationId, args = []) {
      const executable = applications[applicationId];
      if (!executable) throw new Error("Application is not allowlisted by the local operator.");
      if (!Array.isArray(args) || args.length > 32 ||
          args.some((arg) => typeof arg !== "string" || arg.length > 1000 || arg.includes("\0"))) {
        throw new Error("Invalid application launch arguments.");
      }
      const macApplicationBundle = process.platform === "darwin" && executable.toLowerCase().endsWith(".app");
      const launchCommand = macApplicationBundle ? "/usr/bin/open" : executable;
      const launchArgs = macApplicationBundle ? ["-a", executable, "--args", ...args] : args;
      const child = spawn(launchCommand, launchArgs, {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: false,
        env: safeLaunchEnvironment(),
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      child.unref();
      return { launched: true, applicationId };
    },
  };
}

function safeLaunchEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? ["PATH", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]
    : ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"];
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export function describeDesktopAction(action: DesktopAction): string {
  switch (action.kind) {
    case "screen.capture": return "Capture the full local desktop — image contents may contain private information.";
    case "app.launch":
      return [
        "Launch application",
        "Application ID: " + action.applicationId,
        "Arguments: " + (action.args.length ? JSON.stringify(action.args) : "(none)"),
      ].join("\n");
    case "input.click": return "Mouse click (" + action.x + ", " + action.y + ") — not supported by this host.";
    case "input.type": return "Type text — not supported by this host.";
    case "input.key": return "Press key " + action.key + " — not supported by this host.";
  }
}
