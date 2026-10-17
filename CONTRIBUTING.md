# Contributing to Sofia Agent

Thank you for helping improve Sofia Agent. Contributions should improve reliability, security, usability, or documentation without weakening permission boundaries.

## Before opening a pull request

1. Open or find an issue describing the problem or proposed change.
2. Keep changes focused and explain the user-visible behavior.
3. Add tests for behavior changes and security fixes.
4. Never commit credentials, tokens, private user data, generated secrets, or production logs.
5. Do not claim a provider, platform, or capability works unless it has reproducible test evidence.

## Local development

- Node.js 20 or newer (CI currently validates on Node.js 24).
- Install dependencies with `npm ci`.
- Run `npm run license:check`.
- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run build`.

Report each check separately. If a check cannot be run, say so explicitly.

## Security-sensitive changes

Changes involving authentication, authorization, workspace paths, shell/terminal execution, browser networking, secrets, approvals, or durable jobs require:
- a clear threat model and trust boundary;
- negative tests for unauthorized and malformed inputs;
- least privilege by default;
- explicit approval for destructive or high-impact actions where applicable;
- no secret values in logs, errors, tests, screenshots, or docs.

Do not add a new channel-specific planner or execution engine. Client adapters should route through the shared Sofia API/Core and retain the same policy enforcement.

## Pull request checklist

- [ ] Scope and rationale are clear.
- [ ] Tests cover new behavior and relevant failure paths.
- [ ] Typecheck, tests, build, and license checks are reported accurately.
- [ ] Docs and configuration examples are updated.
- [ ] No secrets or unnecessary personal data are included.
- [ ] Third-party dependencies and assets have appropriate licenses.
- [ ] Any limitations are stated rather than hidden.

By submitting a contribution, you agree that it may be distributed under the repository's MIT license unless a separate written agreement says otherwise. Do not submit work you do not have the right to license.
