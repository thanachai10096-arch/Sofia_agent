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

## Integration boundary

The new class is an opt-in retrieval adapter. Callers that want semantic search
can construct it around the existing store and call `find(query)`; existing
callers are unchanged. Before making it the default for agent runs, benchmark
retrieval quality, latency, memory use, and cost against representative project
memories. Keep the Python endpoint on a private network and rotate the shared
service token like any other secret.
