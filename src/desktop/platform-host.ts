import { spawn } from "node:child_process";
import type { DesktopAction, DesktopHostDriver } from "./types.js";

interface CommandOutput { stdout: Buffer; stderr: Buffer }
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number },
) => Promise<CommandOutput>;

function runNativeCommand(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<CommandOutput> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 6 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? minimalEnvironment(),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Native desktop command timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxOutputBytes) {
        child.kill();
        finish(new Error("Native desktop command output exceeded its size limit."));
      } else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 16_384) stderr.push(Buffer.from(chunk).subarray(0, 16_384));
    });
    child.once("error", () => finish(new Error("Required native desktop utility is unavailable.")));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) finish(new Error("Native desktop command failed (exit " + String(code) + ")."));
      else finish();
    });
  });
}

function minimalEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
    : ["PATH", "HOME", "USER", "LOGNAME", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const [name, value] of Object.entries(extra)) if (value !== undefined) env[name] = value;
  return env;
}

function pngDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 24 || data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      data.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Native screen capture did not return a valid PNG image.");
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || data.length > 3.75 * 1024 * 1024) {
    throw new Error("Native screen capture returned dimensions or size outside the supported limits.");
  }
  return { width, height };
}

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$source = @'
using System;
using System.Runtime.InteropServices;
public static class SofiaNativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public UInt32 type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public UInt16 wVk; public UInt16 wScan; public UInt32 dwFlags; public UInt32 time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public Int32 dx; public Int32 dy; public UInt32 mouseData; public UInt32 dwFlags; public UInt32 time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)] public static extern UInt32 SendInput(UInt32 n, INPUT[] inputs, Int32 size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(Int32 x, Int32 y);
  [DllImport("user32.dll")] public static extern void mouse_event(UInt32 flags, UInt32 dx, UInt32 dy, UInt32 data, UIntPtr extra);
  public static void Key(UInt16 vk, bool down) {
    var i = new INPUT(); i.type=1; i.U.ki.wVk=vk; i.U.ki.dwFlags=down?0u:2u;
    if (SendInput(1,new INPUT[]{i},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("SendInput failed");
  }
  public static void Text(string value) {
    foreach(char ch in value) {
      var down=new INPUT(); down.type=1; down.U.ki.wScan=ch; down.U.ki.dwFlags=4;
      var up=down; up.U.ki.dwFlags=6;
      if(SendInput(2,new INPUT[]{down,up},Marshal.SizeOf(typeof(INPUT)))!=2) throw new Exception("SendInput failed");
    }
  }
}
'@
Add-Type -TypeDefinition $source
switch ($env:SOFIA_NATIVE_OPERATION) {
  'capture' {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($bounds.Width -lt 1 -or $bounds.Height -lt 1 -or $bounds.Width -gt 16384 -or $bounds.Height -gt 16384) { throw 'Invalid screen bounds' }
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bitmap.Size)
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
    [Console]::Out.WriteLine(($bounds.Width.ToString() + ',' + $bounds.Height.ToString() + ',' + [Convert]::ToBase64String($stream.ToArray())))
    $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose()
  }
  'click' {
    $x=[int]$env:SOFIA_NATIVE_X; $y=[int]$env:SOFIA_NATIVE_Y
    if (-not [SofiaNativeInput]::SetCursorPos($x,$y)) { throw 'SetCursorPos failed' }
    $down=if($env:SOFIA_NATIVE_BUTTON -eq 'right'){8}elseif($env:SOFIA_NATIVE_BUTTON -eq 'middle'){32}else{2}
    $up=if($env:SOFIA_NATIVE_BUTTON -eq 'right'){16}elseif($env:SOFIA_NATIVE_BUTTON -eq 'middle'){64}else{4}
    [SofiaNativeInput]::mouse_event($down,0,0,0,[UIntPtr]::Zero); [SofiaNativeInput]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
  }
  'type' { [SofiaNativeInput]::Text($env:SOFIA_NATIVE_TEXT) }
  'key' {
    $mods=@(); if($env:SOFIA_NATIVE_MODIFIERS){$mods=$env:SOFIA_NATIVE_MODIFIERS.Split(',')}
    $vk=[UInt16]::Parse($env:SOFIA_NATIVE_VK)
    $map=@{CTRL=0x11;ALT=0x12;SHIFT=0x10}
    foreach($m in $mods){[SofiaNativeInput]::Key([UInt16]$map[$m],$true)}
    [SofiaNativeInput]::Key($vk,$true); [SofiaNativeInput]::Key($vk,$false)
    for($i=$mods.Length-1;$i -ge 0;$i--){[SofiaNativeInput]::Key([UInt16]$map[$mods[$i]],$false)}
  }
}
`;

function windowsKey(key: string): { vk: number; modifiers: string[] } {
  const parts = key.split("+");
  const base = parts.pop()!;
  const modifiers = parts.map((part) => part.toUpperCase());
  const names: Record<string, number> = {
    ENTER: 0x0d, ESCAPE: 0x1b, TAB: 0x09, BACKSPACE: 0x08, DELETE: 0x2e,
    ARROWUP: 0x26, ARROWDOWN: 0x28, ARROWLEFT: 0x25, ARROWRIGHT: 0x27,
    HOME: 0x24, END: 0x23, PAGEUP: 0x21, PAGEDOWN: 0x22, SPACE: 0x20,
  };
  const upper = base.toUpperCase();
  const vk = names[upper] ?? (upper.length === 1 && /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0)
    : /^F(?:[1-9]|1[0-2])$/.test(upper) ? 0x70 + Number(upper.slice(1)) - 1 : 0);
  if (!vk) throw new Error("Unsupported Windows desktop key.");
  return { vk, modifiers };
}

function xdotoolKey(key: string): string {
  const names: Record<string, string> = {
    Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "BackSpace", Delete: "Delete",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Home: "Home", End: "End", PageUp: "Page_Up", PageDown: "Page_Down", Space: "space",
  };
  return key.split("+").map((part) => {
    const upper = part.toUpperCase();
    if (upper === "CTRL") return "ctrl";
    if (upper === "ALT") return "alt";
    if (upper === "SHIFT") return "shift";
    if (upper === "CMD") return "Super";
    return names[part] ?? part;
  }).join("+");
}

function macKey(key: string): string[] {
  const names: Record<string, string> = {
    Enter: "ENTER", Escape: "ESC", Tab: "TAB", Backspace: "DELETE", Delete: "FORWARD_DELETE",
    ArrowUp: "ARROW_UP", ArrowDown: "ARROW_DOWN", ArrowLeft: "ARROW_LEFT", ArrowRight: "ARROW_RIGHT",
    Home: "HOME", End: "END", PageUp: "PAGE_UP", PageDown: "PAGE_DOWN", Space: "SPACE",
  };
  const parts = key.split("+");
  const base = parts.pop()!;
  const commands: string[] = [];
  const modifierNames: Record<string, string> = { Ctrl: "CTRL", Alt: "ALT", Shift: "SHIFT", Cmd: "CMD" };
  for (const modifier of parts) commands.push("kd:" + (modifierNames[modifier] ?? modifier.toUpperCase()));
  commands.push("kp:" + (names[base] ?? base.toUpperCase()));
  for (const modifier of parts.reverse()) commands.push("ku:" + (modifierNames[modifier] ?? modifier.toUpperCase()));
  return commands;
}

/**
 * Uses native OS utilities without a shell. Linux automation is deliberately
 * limited to X11/xdotool; Wayland requires a separately configured trusted input
 * backend. macOS uses screencapture/cliclick and Windows uses SendInput via
 * a fixed PowerShell script. Every operation is still locally approved.
 */
export function createPlatformDesktopHostDriver(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: NativeCommandRunner;
} = {}): DesktopHostDriver {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runNativeCommand;
  const call = (command: string, args: string[], extra: NodeJS.ProcessEnv = {}, timeoutMs = 15_000) =>
    run(command, args, { env: minimalEnvironment(extra), timeoutMs, maxOutputBytes: 6 * 1024 * 1024 });
  const powershell = (operation: string, extra: NodeJS.ProcessEnv = {}, timeoutMs = 20_000) =>
    call("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT],
      { ...extra, SOFIA_NATIVE_OPERATION: operation }, timeoutMs);

  return {
    async captureScreen(options) {
      if (options?.displayId !== undefined) throw new Error("Selecting an individual display is not supported; capture the full virtual desktop instead.");
      let data: Buffer;
      if (platform === "darwin") {
        ({ stdout: data } = await call("/usr/sbin/screencapture", ["-x", "-"]));
      } else if (platform === "win32") {
        const output = (await powershell("capture")).stdout.toString("utf8").trim();
        const parts = output.split(",");
        if (parts.length !== 3) throw new Error("Windows screen capture returned an invalid response.");
        const width = Number(parts[0]); const height = Number(parts[1]);
        data = Buffer.from(parts[2]!, "base64");
        const dimensions = pngDimensions(data);
        if (dimensions.width !== width || dimensions.height !== height) throw new Error("Windows screen capture dimensions did not match.");
        return { mimeType: "image/png", data, width, height };
      } else if (platform === "linux") {
        if (env.WAYLAND_DISPLAY && !env.DISPLAY) throw new Error("Screen capture on Wayland is not enabled in this build; configure an approved Wayland capture backend.");
        ({ stdout: data } = await call("scrot", ["-"]));
      } else {
        throw new Error("Native screen capture is not supported on this operating system.");
      }
      const dimensions = pngDimensions(data);
      return { mimeType: "image/png", data, ...dimensions };
    },
    async launchApplication() {
      throw new Error("Application launch must use the separate allowlisted local host driver.");
    },
    async click(point) {
      if (platform === "linux") {
        if (env.WAYLAND_DISPLAY && !env.DISPLAY) throw new Error("Input control on Wayland is not enabled in this build.");
        const button = point.button === "right" ? "3" : point.button === "middle" ? "2" : "1";
        await call("xdotool", ["mousemove", "--sync", String(point.x), String(point.y), "click", button]);
      } else if (platform === "darwin") {
        const command = point.button === "right" ? "rc" : point.button === "middle" ? "mc" : "c";
        await call("cliclick", ["m:" + point.x + "," + point.y, command + ":" + point.x + "," + point.y]);
      } else if (platform === "win32") {
        await powershell("click", {
          SOFIA_NATIVE_X: String(point.x), SOFIA_NATIVE_Y: String(point.y), SOFIA_NATIVE_BUTTON: point.button ?? "left",
        });
      } else throw new Error("Native mouse control is not supported on this operating system.");
    },
    async typeText(text) {
      if (platform === "linux") {
        if (env.WAYLAND_DISPLAY && !env.DISPLAY) throw new Error("Keyboard control on Wayland is not enabled in this build.");
        await call("xdotool", ["type", "--clearmodifiers", "--delay", "1", "--", text], {}, 20_000);
      } else if (platform === "darwin") {
        await call("cliclick", ["t:" + text], {}, 20_000);
      } else if (platform === "win32") {
        await powershell("type", { SOFIA_NATIVE_TEXT: text }, 20_000);
      } else throw new Error("Native keyboard control is not supported on this operating system.");
    },
    async pressKey(key) {
      if (platform === "linux") {
        if (env.WAYLAND_DISPLAY && !env.DISPLAY) throw new Error("Keyboard control on Wayland is not enabled in this build.");
        await call("xdotool", ["key", "--clearmodifiers", xdotoolKey(key)]);
      } else if (platform === "darwin") {
        await call("cliclick", macKey(key));
      } else if (platform === "win32") {
        const parsed = windowsKey(key);
        await powershell("key", {
          SOFIA_NATIVE_VK: String(parsed.vk), SOFIA_NATIVE_MODIFIERS: parsed.modifiers.join(","),
        });
      } else throw new Error("Native keyboard control is not supported on this operating system.");
    },
  };
}
