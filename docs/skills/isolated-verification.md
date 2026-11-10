# Isolated executable skill verification

Sofia distinguishes learned repair guidance from executable skills. A prose-only
skill package is not executable evidence and cannot be promoted by the live
factory evaluator.

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
      "alpha.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict'; import { run } from '../index.mjs'; test('returns expected result', () => assert.equal(run(), 42));"
    },
    "tests": ["alpha.test.mjs"]
  }
]
```

The suite is loaded from deployment configuration, not the skill package.
Duplicate skill IDs, malformed JSON, missing suites, and oversized configuration
fail closed.

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

The entrypoint must be an `.mjs` file. Paths reject traversal, `.git`,
`node_modules`, and the reserved trusted-test directory. Artifact size is
bounded and its digest is bound to the complete candidate.

## What the verifier executes

1. Copies the artifact and operator-owned tests into a fresh temporary workspace.
2. Runs `node --check <entrypoint>`.
3. Runs only the configured trusted test files with `node --test`.
4. Uses `ContainerSandbox` with network disabled, read-only workspace mount,
   no added capabilities, no-new-privileges, and bounded CPU, memory, process
   count, time, and output.
5. Records the candidate digest, runner ID, isolated workspace ID, executed
   checks, trusted suite ID/version, and SHA-256 digest of the exact trusted
   suite contents. The temporary workspace is removed afterward.

The v1 runner does not install dependencies and does not claim TypeScript
`typecheck` or package `build` verification. Candidates requiring checks the
runner did not execute remain ineligible for promotion.

## Current integration boundary

The current Brain learned-repair flow creates prose-only skill packages and does
not generate executable artifacts. The live factory evaluator rejects those
candidates before promotion approval. It is unsafe to turn model-generated
procedure text into executable code by guessing or treating it as trusted.

An operator-reviewed artifact-building pipeline and a matching trusted suite
must be added before learned repairs can become executable skills. This PR does
not add that builder, does not auto-activate skills, and does not deploy the
verifier to production.

The benchmark comparison module and unit tests are included, but a persistent
trusted baseline source and lifecycle benchmark gate are not yet wired into the
factory. No benchmark-gated promotion is claimed.
