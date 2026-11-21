# Desktop Cloud Relay — authenticated request foundation

This document describes the request-authentication primitive added for a future outbound Desktop Companion relay. It does not claim that the Cloud queue, device enrollment, or command delivery service is implemented.

## Request authentication

Each paired desktop device must receive its own random credential containing at least 256 bits of entropy. The credential is a device secret and must be stored in the OS credential store by the eventual Companion. It must never be an API key, appear in model context, or be written to logs.

Every HTTP request is authenticated with:
- x-sofia-device-id: stable, non-secret device identifier
- x-sofia-timestamp: Unix time in milliseconds
- x-sofia-nonce: fresh random value for this request
- x-sofia-signature: HMAC-SHA256 over the canonical request

The signed canonical form is:

    SOFIA-DESKTOP-RELAY-V1
    {deviceId}
    {HTTP method}
    {path including query}
    {timestamp}
    {nonce}
    {SHA-256 of exact request body bytes}

The verifier checks device identity, credential strength, timestamp skew (five minutes by default), the signature using constant-time comparison, and nonce replay. A nonce can be accepted only once within the validity window.

## Important deployment requirements

- Use HTTPS only; never expose the loopback Action Host to the public network.
- Device credentials must be generated per device, revocable, and stored in an OS credential manager.
- The in-memory replay guard is suitable only for a single verifier process. Multi-instance Cloud deployments require an atomic shared nonce store (for example, Redis SET NX with expiry) before enabling relay traffic.
- Enrollment must bind the device to the authenticated account on the server. A device ID supplied by a client is not proof of ownership.
- The server must authorize every command against the device's registered capabilities and owner, not trust requested capabilities from the command payload.
- Commands need unique IDs, short expirations, bounded payloads, idempotent claim/ack semantics, and a durable audit trail.
- The Companion must re-check local capabilities and request real user approval for sensitive actions. Cloud authorization is not a substitute for local approval.
- Revoke must invalidate both the Cloud device credential and any local paired action-host token.

## Current scope

Implemented here: canonical HMAC request signing, timestamp validation, constant-time signature comparison, and bounded in-memory nonce replay protection with regression tests.

Not implemented here: device enrollment, durable device registry, Cloud command queue, polling/stream transport, desktop Companion service, command delivery, acknowledgement, or mobile UI. Do not advertise phone-to-PC remote control as available until those components are integrated and tested end-to-end.