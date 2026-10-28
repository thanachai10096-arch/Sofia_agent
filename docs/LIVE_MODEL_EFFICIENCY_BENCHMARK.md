# Live model efficiency benchmark

This is an opt-in, small live-provider comparison. It makes real API calls and may incur provider charges.

## Run

```sh
GEMINI_API_KEY=... GEMINI_MODEL=gemini-2.5-flash node bench/live-model-efficiency.mjs
```

On PowerShell, set the environment variables before running Node. Never commit API keys or paste them into issue/PR comments. The script does not print the key or provider response bodies on HTTP errors. It does print model answers as part of the local JSON result, so review the output before sharing it.

Optional settings:
- `GEMINI_MODEL`: model identifier; defaults to `gemini-2.5-flash`.
- `GEMINI_OPENAI_BASE_URL`: OpenAI-compatible Gemini base URL; defaults to Google's Generative Language endpoint.
- `SOFIA_LIVE_BENCHMARK_TIMEOUT_MS`: request timeout, 1000–180000 ms; defaults to 45000.

## What it measures

Each of three fixed extraction tasks runs twice, sequentially, on the same model:
1. Baseline: relevant evidence plus repeated irrelevant evidence.
2. Compact: relevant evidence only.

The output reports provider-reported prompt/completion tokens when available, wall-clock latency, and a simple expected-answer substring check. It never estimates actual billing from token counts. If usage fields are missing, it labels usage incomplete and exits non-zero.

## Limitations

- This is a live provider smoke benchmark, not an end-to-end Sofia Agent task benchmark.
- The compact context is manually selected; this script does **not** invoke Sofia's `TokenAwareGateway` evidence packer.
- Three extraction fixtures are too small to support general claims about quality, task success, or savings across real workloads.
- A valid comparison requires the same model, provider, and task fixtures; model output and latency can vary between calls.
- Do not run this in CI by default: it needs a real credential and makes billable provider calls.
- Reported token totals are provider-reported usage; actual invoiced cost remains unknown.
