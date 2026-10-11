export { DesktopRuntime, createDesktopPrincipal } from "./runtime.js";
export { createDesktopTools } from "./tools.js";
export { createDesktopAdapterTools } from "./adapter.js";
export { createNativeDesktopDriver } from "./native-driver.js";
export type { NativeDesktopDriverConfig } from "./native-driver.js";
export { DesktopPermissionError, requireCapability, resolveWorkspacePath, resolveWorkspaceRoot } from "./policy.js";
export type { DesktopCapability, DesktopCommandResult, DesktopFileEntry, DesktopPrincipal, DesktopRuntimeConfig, DesktopSystemInfo, DesktopAction, DesktopAdapterConfig, DesktopHostDriver } from "./types.js";
