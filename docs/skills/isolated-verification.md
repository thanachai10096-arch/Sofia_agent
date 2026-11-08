# Isolated executable skill verification

Sofia distinguishes learned repair guidance from executable skills. A prose-only
skill package is not executable evidence and cannot be promoted by the production
lifecycle.

## Required configuration

The verifier requires both:

- `SOFIA_SKILL_SANDBOX_IMAGE`: a locally available OCI image pinned by an immutable
  `@sha256:<64-hex-digest>`. The image must contain Node.js and must be preloaded;
  the sandbox never pulls images at runtime.
- `SOFIA_SKILL_TRUSTED_TEST_SUITES`: operator-owned JSON configuration containing
  independent tests keyed by exact skill ID. Candidate artifacts cannot provide
  or replace these tests.

Example trusted-suite configuration:

```json
[
  {
    "skillId": "skill.alpha",
    "id": "alpha-contract",
    "version": "1",
    "files": {
      "alpha.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict'; import { run } from '../index.mjs'; test('returns the expected result', () => assert.equal(run(), 42));"
    },
    "tests": ["alpha.test.mjs"]
  }
]
```

The test suite is loaded from deployment configuration, not from the skill
package. Duplicate entries for a skill ID, malformed JSON, missing suites, and
oversized configuration fail closed.

## Executable artifact format

A candidate must include an artifact with this shape:

```json
{
  "format": "sofia-node-skill-v1",
  "runtime": "node",
  "entrypoint": "index.mjs",
  "files": {
    "index.mjs": "export function run() { return 42; }"
  }
}
```

The entrypoint must be an `.mjs` file. Paths are workspace-relative and reject
traversal, `.git`, `node_modules`, and the reserved trusted-test directory.
The artifact is size-bounded and SHA-256-bound to the complete skill candidate.

## What the verifier executes

1. Copies the artifact and operator-owned tests into a fresh temporary workspace.
2. Runs `node --check <entrypoint>`.
3. Runs only the configured trusted test files with `node --test`.
4. Uses the digest-pinned `ContainerSandbox` with network disabled, a read-only
   workspace mount, no added capabilities, no-new-privileges, and bounded CPU,
   memory, process count, time, and output.
5. Records candidate digest, runner ID, isolated workspace ID, executed checks,
   and trusted suite ID/version. The temporary workspace is removed afterward.

The v1 runner does not install dependencies and does not claim TypeScript
`typecheck` or package `build` verification. Candidates that require checks the
runner did not execute remain ineligible for promotion.

## Current limitation

The managed learned-repair flow still creates prose-only packages and does not
produce executable artifacts. Therefore those candidates remain blocked from
promotion. Operators must deliberately create an executable artifact and a
matching trusted test suite before the runtime can verify it. No production
deployment or automatic skill activation is implied by adding this verifier.
