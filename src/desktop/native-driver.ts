import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopHostDriver } from "./types.js";

const execFileAsync = promisify(execFile);
type NativePlatform = "win32" | "darwin" | "linux";
export interface NativeDesktopDriverConfig {
  /** Exact IDs mapped to a fixed executable path and fixed, operator-authored arguments. */
  applications?: Readonly<Record<string, { executable: string; args?: readonly string[] }>>;
  /** Override only for testing; production defaults to the current OS. */
  platform?: NativePlatform;
  /** Bound each native command. */
  commandTimeoutMs?: number;
}

const KEY_CODES: Record<string, number> = {
  Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38,
  ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35,
  PageUp: 33, PageDown: 34, Space: 32,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

function assertSafeKey(key: string): void {
  if (!/^(?:[A-Za-z0-9]|Enter|Escape|Tab|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Space|F(?:[1-9]|1[0-2])|Ctrl\+[A-Za-z0-9]|Alt\+[A-Za-z0-9]|Shift\+[A-Za-z0-9])$/.test(key)) {
    throw new Error("Unsupported desktop key.");
  }
}

function keyForXdotool(key: string): string {
  if (key.length === 1) return key.toLowerCase();
  const aliases: Record<string, string> = {
    Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "BackSpace",
    Delete: "Delete", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left",
    ArrowRight: "Right", PageUp: "Page_Up", PageDown: "Page_Down", Space: "space",
  };
  if (aliases[key]) return aliases[key];
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return key;
  const combo = /^(Ctrl|Alt|Shift)\+([A-Za-z0-9])$/.exec(key);
  if (combo) {
    const modifier = combo[1] ?? "";
    const key = combo[2] ?? "";
    if (!modifier || !key) throw new Error("Invalid desktop key combination.");
    return `${modifier.toLowerCase()}+${key.toLowerCase()}`;
  }
  return key;
}

const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class SofiaInput { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEKEYBDHARDWAREINPUT U; } [StructLayout(LayoutKind.Explicit)] public struct MOUSEKEYBDHARDWAREINPUT { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public IntPtr dwExtraInfo; } [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk,wScan; public uint dwFlags,time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb); [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); }'",
].join(";");

async function runFile(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync(command, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
}

async function launchFile(command: string, args: string[]): Promise<void> {
  const secretEnv = /(?:TOKEN|SECRET|PASSWORD|PRIVATE.?KEY|API.?KEY|AUTHORIZATION|AWS_ACCESS_KEY|AWS_SECRET|GITHUB_TOKEN|NPM_TOKEN)/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !secretEnv.test(key)));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, env });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function powershellScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Best-effort real OS driver using built-in OS utilities. Linux requires xdotool
 * and one of gnome-screenshot/scrot/ImageMagick import. macOS uses screencapture
 * and AppleScript accessibility events. Windows uses PowerShell/.NET and user32.
 * It never invokes a shell with model-provided command text.
 */
export function createNativeDesktopDriver(config: NativeDesktopDriverConfig = {}): DesktopHostDriver {
  const platform = config.platform ?? process.platform as NativePlatform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") throw new Error("Unsupported desktop platform.");
  const timeout = Math.min(Math.max(1000, config.commandTimeoutMs ?? 15_000), 60_000);
  const apps = config.applications ?? {};

  return {
    async captureScreen() {
      const dir = await mkdtemp(path.join(os.tmpdir(), "sofia-screen-"));
      const file = path.join(dir, "capture.png");
      try {
        if (platform === "darwin") {
          await runFile("/usr/sbin/screencapture", ["-x", file], timeout);
        } else if (platform === "win32") {
          const script = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save($env:SOFIA_CAPTURE_PATH,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $i.Dispose()";
          await runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellScript(script)], timeout, { SOFIA_CAPTURE_PATH: file });
        } else {
          let captured = false;
          for (const [command, args] of [
            ["gnome-screenshot", ["-f", file]],
            ["scrot", [file]],
            ["import", ["-window", "root", file]],
          ] as const) {
            try { await runFile(command, [...args], timeout); captured = true; break; } catch { /* try the next installed utility */ }
          }
          if (!captured) throw new Error("Screen capture unavailable on Linux. Install gnome-screenshot, scrot, or ImageMagick import.");
        }
        const data = await readFile(file);
        if (data.byteLength < 24 || data.byteLength > 5 * 1024 * 1024) throw new Error("Screen capture is empty or exceeds the 5 MiB limit.");
        if (data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Screen capture did not produce a valid PNG.");
        const width = data.readUInt32BE(16);
        const height = data.readUInt32BE(20);
        if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new Error("Screen capture has invalid dimensions.");
        return { mimeType: "image/png" as const, data: new Uint8Array(data), width, height };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async launchApplication(applicationId, args = []) {
      const app = apps[applicationId];
      if (!app || !app.executable || app.executable.includes("\0")) throw new Error("Application ID has no fixed local executable mapping.");
      const fixedArgs = [...(app.args ?? [])];
      if (args.length !== fixedArgs.length || args.some((arg, index) => arg !== fixedArgs[index])) throw new Error("Application arguments must exactly match the operator-configured fixed arguments.");
      await launchFile(app.executable, fixedArgs);
      return { launched: true, applicationId };
    },

    async click(point) {
      const button = point.button ?? "left";
      if (button !== "left" && button !== "right" && button !== "middle") throw new Error("Unsupported mouse button.");
      if (!Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0 || point.x > 16383 || point.y > 16383) throw new Error("Invalid screen coordinates.");
      if (platform === "linux") {
        const buttonNumber = button === "left" ? "1" : button === "middle" ? "2" : "3";
        await runFile("xdotool", ["mousemove", "--sync", String(point.x), String(point.y), "click", "--clearmodifiers", buttonNumber], timeout);
      } else if (platform === "darwin") {
        const script = "on run argv\n tell application \"System Events\" to click at {item 1 of argv as integer, item 2 of argv as integer}\nend run";
        if (button !== "left") throw new Error("macOS built-in driver supports left click only.");
        await runFile("/usr/bin/osascript", ["-e", script, String(point.x), String(point.y)], timeout);
      } else {
        const flag = button === "left" ? 0x0002 : button === "right" ? 0x0008 : 0x0020;
        const upFlag = button === "left" ? 0x0004 : button === "right" ? 0x0010 : 0x0040;
        const script = WINDOWS_SCRIPT + `; [SofiaInput]::SetCursorPos([int]$env:SOFIA_X,[int]$env:SOFIA_Y) | Out-Null; $a=New-Object SofiaInput+INPUT[] 2; $a[0].type=0; $a[0].U.mi.dwFlags=${flag}; $a[1].type=0; $a[1].U.mi.dwFlags=${upFlag}; [SofiaInput]::SendInput(2,$a,[Runtime.InteropServices.Marshal]::SizeOf([type][SofiaInput+INPUT])) | Out-Null`;
        await runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellScript(script)], timeout, { SOFIA_X: String(point.x), SOFIA_Y: String(point.y) });
      }
    },

    async typeText(text) {
      if (text.includes("\0")) throw new Error("Text cannot contain NUL.");
      if (platform === "linux") {
        await runFile("xdotool", ["type", "--clearmodifiers", "--delay", "0", "--", text], timeout);
      } else if (platform === "darwin") {
        const script = "on run argv\n tell application \"System Events\" to keystroke (item 1 of argv)\nend run";
        await runFile("/usr/bin/osascript", ["-e", script, text], timeout);
      } else {
        const script = WINDOWS_SCRIPT + "; $bytes=[Convert]::FromBase64String($env:SOFIA_TEXT_B64); $s=[System.Text.Encoding]::UTF8.GetString($bytes); foreach($ch in $s.ToCharArray()){ $down=New-Object SofiaInput+INPUT; $down.type=1; $down.U.ki.wScan=[int][char]$ch; $down.U.ki.dwFlags=4; $up=New-Object SofiaInput+INPUT; $up.type=1; $up.U.ki.wScan=[int][char]$ch; $up.U.ki.dwFlags=6; [SofiaInput]::SendInput(1,@($down),[Runtime.InteropServices.Marshal]::SizeOf([type][SofiaInput+INPUT])) | Out-Null; [SofiaInput]::SendInput(1,@($up),[Runtime.InteropServices.Marshal]::SizeOf([type][SofiaInput+INPUT])) | Out-Null }";
        await runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellScript(script)], timeout, { SOFIA_TEXT_B64: Buffer.from(text, "utf8").toString("base64") });
      }
    },

    async pressKey(key) {
      assertSafeKey(key);
      if (platform === "linux") {
        await runFile("xdotool", ["key", "--clearmodifiers", keyForXdotool(key)], timeout);
      } else if (platform === "darwin") {
        const combo = /^(Ctrl|Alt|Shift)\+([A-Za-z0-9])$/.exec(key);
        const modifier = combo ? ({ Ctrl: "control down", Alt: "option down", Shift: "shift down" } as Record<string, string>)[combo[1]!] : "";
        const baseKey = combo ? combo[2]! : key;
        const codes: Record<string, number> = { Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126 };
        const code = codes[baseKey];
        const script = modifier
          ? `on run argv\n tell application "System Events" to keystroke (item 1 of argv) using {${modifier}}\nend run`
          : code !== undefined
            ? `tell application "System Events" to key code ${code}`
            : `on run argv\n tell application "System Events" to keystroke (item 1 of argv)\nend run`;
        await runFile("/usr/bin/osascript", modifier || code === undefined ? ["-e", script, baseKey] : ["-e", script], timeout);
      } else {
        const combo = /^(Ctrl|Alt|Shift)\+([A-Za-z0-9])$/.exec(key);
        const base = combo ? combo[2]!.toUpperCase().charCodeAt(0) : KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
        if (base === undefined) throw new Error("Key is not supported by the Windows native driver.");
        const modifierCodes = combo ? [({ Ctrl: 0x11, Alt: 0x12, Shift: 0x10 } as Record<string, number>)[combo[1]!]] : [];
        const codes = [...modifierCodes, base];
        const events = codes.map((code) => `$a[$i].type=1; $a[$i].U.ki.wVk=${code}; $a[$i].U.ki.dwFlags=0; $i++`).concat([...codes].reverse().map((code) => `$a[$i].type=1; $a[$i].U.ki.wVk=${code}; $a[$i].U.ki.dwFlags=2; $i++`)).join("; ");
        const script = WINDOWS_SCRIPT + `; $a=New-Object SofiaInput+INPUT[] ${codes.length * 2}; $i=0; ${events}; [SofiaInput]::SendInput($a.Length,$a,[Runtime.InteropServices.Marshal]::SizeOf([type][SofiaInput+INPUT])) | Out-Null`;
        await runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellScript(script)], timeout);
      }
    },
  };
}
