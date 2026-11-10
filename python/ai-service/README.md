# Sofia AI Service (Python)

An optional, isolated specialist service for semantic embeddings and reranking. It is not the Sofia Agent runtime and is not yet wired into production routing.

## Why Python

The initial use case is semantic retrieval: Sentence Transformers provides accessible pretrained embedding and cross-encoder reranking models. The TypeScript Core can call this service when the product integrates semantic retrieval; it remains responsible for authorization, tools, jobs, and final decisions.

## Run locally

Use Python 3.12. Install dependencies and configure a strong internal-only token:

```sh
python -m venv .venv
. .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements-dev.txt
export SOFIA_AI_SERVICE_TOKEN='replace-with-a-long-random-secret'
uvicorn app:app --host 127.0.0.1 --port 8091
```

The first request to an AI endpoint downloads the configured model, so first-call latency and disk/RAM usage can be significant. Set `SOFIA_EMBEDDING_MODEL` and `SOFIA_RERANKER_MODEL` to approved model identifiers as needed. Never expose this service publicly without network controls, a secret manager, TLS at the service boundary, and rate/resource limits.

## Endpoints

- `GET /health`: liveness only; does not load models.
- `POST /v1/embeddings`: vector embeddings for 1–64 texts.
- `POST /v1/rerank`: relevance-score and rank 1–64 documents for a query.

AI endpoints require `Authorization: Bearer $SOFIA_AI_SERVICE_TOKEN`. Empty text and payloads exceeding configured bounds are rejected. Do not send secrets, credentials, or unnecessary personal data. The response is untrusted model output and must not grant tool permissions or trigger actions by itself.

## Tests and checks

```sh
ruff check .
pytest
```

Tests use deterministic fake models; they do not download model weights. Real model quality, throughput, memory use, and cost must be benchmarked before production routing is enabled.
