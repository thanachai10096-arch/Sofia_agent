# Live model efficiency benchmark

This is an opt-in, provider-agnostic smoke comparison for APIs that implement the OpenAI-compatible `/chat/completions` endpoint. It makes real API calls and may incur provider charges. It has no default provider, endpoint, or model, and never silently falls back to another provider.

## Run

Set all three variables for the provider/model you explicitly choose:

```sh
SOFIA_BENCH_API_BASE_URL=https://your-provider.example/v1 \
SOFIA_BENCH_API_KEY=... \
SOFIA_BENCH_MODEL=your-model-id \
node bench/live-model-efficiency.mjs
```

`SOFIA_BENCH_API_BASE_URL` is the API base URL, not a secret. The script appends `/chat/completions` (and also accepts a URL already ending in that path). HTTPS is required except for localhost testing. The provider must accept a Bearer API key and the OpenAI-compatible chat-completions request/response shape. Other provider APIs are not supported by this harness unless they expose that compatibility interface.

Optional setting:
- `SOFIA_LIVE_BENCHMARK_TIMEOUT_MS`: request timeout, 1000–180000 ms; defaults to 45000.

Never commit API keys or paste them into issue/PR comments. The script does not print the key or provider response bodies on HTTP errors. It does print model answers as part of the local JSON result, so review the output before sharing it.

## What it measures

Each of three fixed synthetic extraction tasks runs twice, sequentially, on the same explicitly configured endpoint and model:
1. Baseline: relevant evidence plus repeated irrelevant evidence.
2. Compact: relevant evidence only.

The output reports provider-reported prompt/completion or input/output tokens when available, wall-clock latency, and a simple expected-answer substring check. It never estimates actual billing from token counts. If usage fields are missing, it labels usage incomplete and exits non-zero.

## Limitations

- This is a live provider smoke benchmark, not an end-to-end Sofia Agent task benchmark.
- The compact context is manually selected; this script does **not** invoke Sofia's `TokenAwareGateway` evidence packer.
- Three synthetic extraction fixtures are too small to support general claims about quality, task success, or savings across real workloads.
- A valid comparison requires the same endpoint, model, and task fixtures; model output and latency can vary between calls.
- Do not run this in CI by default: it needs a real credential and makes billable provider calls.
- Reported token totals are provider-reported usage; actual invoiced cost remains unknown.
- This harness is API-compatible rather than universal: providers with a different request/response protocol need a dedicated adapter before they can be benchmarked here.
