# Optional Python Semantic Retrieval

Sofia's existing TypeScript `ProjectMemoryStore` remains the system of record. The
optional `SemanticProjectMemorySearch` layer asks the private Python AI service to
embed a query and memory entries, then optionally rerank the most relevant results.
The service returns numeric vectors and ranking scores only; it does not read or
write the memory store and cannot authorize tools or actions.

## Configure

Set these environment variables in the Sofia process:

- `SOFIA_AI_SERVICE_URL`: private service base URL. HTTPS is required except for
  localhost development URLs.
- `SOFIA_AI_SERVICE_TOKEN`: bearer token matching the service's
  `SOFIA_AI_SERVICE_TOKEN`.

If either variable is absent, the URL is invalid, or the service is unavailable,
retrieval uses the existing lexical `ProjectMemoryStore.find()` path. This makes
Python optional for local/open-source users and avoids making core memory depend
on model downloads or a separate service.

## Benchmark before production

A real-service benchmark is available at
`python/ai-service/benchmarks/benchmark_memory.py`. It compares embedding-only
ranking with cross-encoder reranking using Recall@3, MRR, and request latency.
The bundled data is only a smoke dataset; add representative, human-labeled cases
and compare cold-start/warm latency, memory, and operating cost before enabling
semantic retrieval by default.

## Integration boundary

The adapter is opt-in at configuration time. Python returns ranking data only;
TypeScript remains the authority for memory storage, permissions, approvals, and
actions. Keep the service on a private network and rotate its bearer token.
