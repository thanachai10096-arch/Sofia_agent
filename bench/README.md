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

The benchmark covers ten task families: arithmetic boundaries, chunking, date/DST, CSV quoting, Thai-aware slugging, LRU behavior, path traversal, Thai baht words, VAT rounding, and Thai Buddhist dates. The self-test must pass before interpreting agent scores. Reference/no-op scores validate the harness, not Sofia's real capability.
