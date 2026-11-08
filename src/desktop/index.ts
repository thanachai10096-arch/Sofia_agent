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

export { createDesktopRelayNonce, signDesktopRelayRequest, verifyDesktopRelayRequest, DesktopRelayReplayGuard } from "./relay-protocol.js";
export type { DesktopRelayRequest, DesktopRelayAuthHeaders, DesktopRelayReplayGuardOptions } from "./relay-protocol.js";

export { DesktopDeviceCredentialVault } from "./device-registry.js";
export type { EncryptedDesktopDeviceSecret, DesktopDeviceRecord, DesktopDeviceRegistryStore, DesktopDeviceCredentialVaultOptions } from "./device-registry.js";

export { RedisDesktopDeviceRegistryStore } from "./redis-device-registry-store.js";
export type { RedisDesktopDeviceRegistryStoreOptions } from "./redis-device-registry-store.js";
export { REDIS_DESKTOP_DEVICE_CREATE_SCRIPT, REDIS_DESKTOP_DEVICE_GET_SCRIPT, REDIS_DESKTOP_DEVICE_LIST_SCRIPT, REDIS_DESKTOP_DEVICE_REVOKE_SCRIPT } from "./redis-device-registry-store.js";

export { DesktopDeviceEnrollmentService } from "./device-enrollment.js";
export type {
  DesktopEnrollmentChallenge,
  DesktopEnrollmentChallengeStore,
  DesktopDeviceEnrollmentServiceOptions,
  StartedDesktopEnrollment,
  CompletedDesktopEnrollment,
} from "./device-enrollment.js";
export { RedisDesktopEnrollmentChallengeStore } from "./redis-enrollment-challenge-store.js";
export type { RedisDesktopEnrollmentChallengeStoreOptions } from "./redis-enrollment-challenge-store.js";
export { REDIS_DESKTOP_ENROLLMENT_CREATE_SCRIPT, REDIS_DESKTOP_ENROLLMENT_CONSUME_SCRIPT } from "./redis-enrollment-challenge-store.js";
