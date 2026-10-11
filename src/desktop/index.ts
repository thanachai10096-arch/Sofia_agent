export { DesktopRuntime, createDesktopPrincipal } from "./runtime.js";
export { createDesktopTools } from "./tools.js";
export { createDesktopAdapterTools } from "./adapter.js";
export { createNativeDesktopDriver } from "./native-driver.js";
export type { NativeDesktopDriverConfig } from "./native-driver.js";
export { DesktopPermissionError, requireCapability, resolveWorkspacePath, resolveWorkspaceRoot } from "./policy.js";
export type { DesktopCapability, DesktopCommandResult, DesktopFileEntry, DesktopPrincipal, DesktopRuntimeConfig, DesktopSystemInfo, DesktopAction, DesktopAdapterConfig, DesktopHostDriver } from "./types.js";

export { DesktopPairingAuthority } from "./pairing.js";
export type { DesktopPairingConfig } from "./pairing.js";
export { startLocalPairingHost } from "./local-pairing-host.js";
export type { LocalPairingHost, LocalPairingHostConfig } from "./local-pairing-host.js";

export { startLocalDesktopActionHost } from "./local-action-host.js";
export type { LocalDesktopActionHost, LocalDesktopActionHostConfig } from "./local-action-host.js";
