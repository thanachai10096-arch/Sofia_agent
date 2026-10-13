# Sofia Agent Benchmark

Node.js 20+ benchmark for observable task success. Checks run only after the agent finishes; the agent does not get the checker in its workspace.

## Run locally

```bash
node bench/run.mjs --selftest
node bench/run.mjs --agent noop
node bench/run.mjs --agent reference
# For Sofia API: start Sofia against a disposable workspace, then:
SOFIA_API_KEY=... node bench/run.mjs --agent http --url http://localhost:3000 --shared-workspace /tmp/sofia-bench-workspace
```

Agents supported: `noop`, `reference`, `command`, and `http`. Command agents receive `BENCH_PROMPT`, `BENCH_WORKSPACE`, and `BENCH_TASK_ID`. Results are written as JSON to stdout and include per-task duration. Use `--timeout-ms 120000` to change the command/API/checker timeout (valid range: 1–3600000 ms). The HTTP adapter requires valid JSON with `status: "completed"` and a result, plus a passing local acceptance check. Its `--shared-workspace` must already exist and be empty at startup; use a new disposable directory configured as Sofia’s actual workspace. The runner deletes the task target file and checker file after each run, so never point it at a real project.

The versioned benchmark currently covers 13 deterministic tasks across coding, data handling, localization, security, documentation, source-grounded research, and automation. Cases include arithmetic boundaries, chunking, date handling, CSV quoting, Thai-aware slugging, LRU behavior, path traversal, Thai baht words, VAT rounding, Thai Buddhist dates, README completeness, source-grounded security notes, and sequential batch automation. The report includes per-task duration and category pass rates. When the HTTP API exposes Brain usage, model calls, tool calls, and token counts are recorded; provider cost is deliberately `null` until the API exposes authoritative cost data. The self-test must pass before interpreting agent scores. Reference/no-op scores validate the harness, not Sofia's real capability.


## Interpreting results

- `--selftest` validates that all 13 fixtures fail without their target file and pass with the reference solution. This is harness validation, not agent quality.
- `--agent reference` is a positive control; `--agent noop` is a negative control.
- A task passes only when its local checker passes and, for HTTP mode, the API reports a completed result.
- Category pass rates are reported to prevent strong coding scores from hiding weak documentation, research, data, localization, security, or automation performance.
- Duration is measured by the harness. Token usage is included only when the response contains it. Cost is not inferred from token counts or model names; `providerCostUsd: null` means unavailable, not free.
