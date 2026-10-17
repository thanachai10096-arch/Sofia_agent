# Real-model benchmark

The existing evaluation runner and the real-provider benchmark measure different things. A mock/reference benchmark is useful for deterministic regression tests, but it is not evidence of real model quality.

## Run

1. Install dependencies with `npm ci`.
2. Configure `AI_GATEWAY_API_KEY` and the required internal `SOFIA_FAST_MODEL`, `SOFIA_CODING_MODEL`, and/or `SOFIA_REASONING_MODEL` values.
3. Run `npm run build`.
4. Run `npm run benchmark:real-model`.

The script uses the configured provider and copies a small set of repository files into a temporary workspace. Agent actions are scoped to that temporary workspace, which is removed afterward. The report includes success rate, elapsed time, step count, and tool event counts; it deliberately excludes model output, prompts, provider error messages, and credentials.

Real-provider calls can incur cost and vary by provider, model, configuration, and time. Run the same benchmark cases repeatedly and publish the environment/configuration and raw aggregate results before drawing comparisons. This script is a reproducible starting point, not an independent quality score or a guarantee that every task succeeds.
