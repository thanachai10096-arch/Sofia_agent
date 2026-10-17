# Semantic memory benchmark

This benchmark calls the real Python AI service and reports request latency plus
Recall@3 and MRR for embedding-only ranking versus cross-encoder reranking. It
does not download models itself; the service downloads/loads configured models.

## Run

Start the private service with model dependencies installed and
`SOFIA_AI_SERVICE_TOKEN` configured. Then run from the repository root:

```sh
export SOFIA_AI_SERVICE_URL=https://your-private-ai-service.example
export SOFIA_AI_SERVICE_TOKEN='your-token'
python python/ai-service/benchmarks/benchmark_memory.py
```

For local development, `http://localhost:8000` is accepted. Never expose the
service publicly without TLS, authentication, rate limits, and network controls.
The script refuses non-local plain HTTP URLs.

## Interpreting results

- Compare embedding-only retrieval to reranked retrieval; reranking should justify
  its added latency before being enabled on every request.
- Measure cold-start separately from warm requests. This script reports observed
  request latency, including network time, but excludes service startup/model load
  unless the first request triggers model loading.
- The bundled cases are a smoke-test dataset, not a statistically meaningful
  quality evaluation. Add anonymized, representative, human-labeled queries from
  real Sofia workflows before changing production defaults.
- Do not log tokens or send private repository data to an untrusted service.
