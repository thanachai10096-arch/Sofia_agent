# Sofia Agent Benchmark

Node.js 20+ benchmark for observable task success. Checks run only after the agent finishes; the agent does not get the checker in its workspace.

## Run locally

```bash
node bench/run.mjs --selftest
node bench/run.mjs --agent noop
node bench/run.mjs --agent reference
# For Sofia API: start Sofia against a disposable workspace, then:
SOFIA_API_KEY=... node bench/run.mjs --agent http --url http://localhost:3000 --shared-workspace /tmp/sofia-bench-workspace --repeat 3
```

Agents supported: `noop`, `reference`, `command`, and `http`. Command agents receive `BENCH_PROMPT`, `BENCH_WORKSPACE`, and `BENCH_TASK_ID`. Results are written as JSON and Markdown. Never point the HTTP runner at a real project: its managed workspace is cleaned between tasks.

The benchmark covers ten task families: arithmetic boundaries, chunking, date/DST, CSV quoting, Thai-aware slugging, LRU behavior, path traversal, Thai baht words, VAT rounding, and Thai Buddhist dates. The self-test must pass before interpreting agent scores. Reference/no-op scores validate the harness, not Sofia's real capability.
