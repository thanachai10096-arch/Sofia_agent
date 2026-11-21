# TypeScript adapter boundary for the Python AI service

Status: opt-in adapter foundation; not wired into Brain, memory, Gateway, or production routing.

## Decision

`PythonAiServiceClient` is a transport-only adapter for the existing Python `/v1/embeddings` and `/v1/rerank` endpoints. It validates responses and has no authority over identity, tenant isolation, memory storage, retrieval policy, authorization, tools, or agent decisions.

The existing TypeScript `ProjectMemoryStore` and `UserMemoryStore` remain authoritative. A future caller may use embeddings/reranking to improve candidate ordering, but must retain its current lexical retrieval path as fallback. The adapter surfaces failures instead of silently substituting empty results; callers own fallback decisions.

## Security and reliability contract

- Configure endpoint and token only from trusted server-side configuration; never accept either from a user request.
- Require HTTPS except loopback HTTP for local development. Reject credentials, query strings, fragments, and arbitrary URL paths; redirects are disabled.
- Require a high-entropy service token; send it only as a Bearer header and never include it in errors.
- Bound request bytes, item count, per-text characters, response bytes, vector dimensions, and rerank indexes.
- Validate every response as untrusted input, including finite numeric values and exact item counts.
- Apply one overall deadline and caller cancellation. Do not automatically retry model POSTs; retries must be explicitly budgeted by the caller.
- Send a correlation ID header. Do not log prompts, documents, tokens, or raw remote error bodies.
- A Python failure must not block ordinary chat or local lexical memory search.

## Current implementation scope

- `src/ai/python-ai-service-client.ts`: opt-in transport adapter and strict contract validation.
- `src/ai/python-ai-service-client.test.ts`: deterministic mocked transport tests; no model weights or network required.
- No application wiring, schema migration, memory duplication, model routing change, or production endpoint exposure.

## Production gates

1. Add Python-side request-ID propagation and structured, secret-safe operational logs.
2. Add cross-language contract tests against the actual FastAPI app for authorization, invalid payloads, oversized bodies, malformed responses, timeout, and cancellation.
3. Add bounded process-level CPU/RAM/concurrency policy and request rate limits at the private gateway/runtime.
4. Pin/lock the complete transitive Python dependency graph and run vulnerability/license review.
5. Benchmark quality, latency, memory, and cost against the existing TypeScript lexical path on representative, privacy-reviewed data.
6. Only then propose opt-in retrieval integration behind a feature flag with lexical fallback and rollback.
