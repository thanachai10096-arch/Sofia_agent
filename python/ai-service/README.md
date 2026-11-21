# Sofia AI Service (Python)

An optional, isolated specialist service for semantic embeddings and reranking.
It is **not** the Sofia Agent runtime and is **not enabled in production routing** by
this foundation change.

## Ownership boundary

The TypeScript Sofia Core remains authoritative for identity, tenant isolation,
authorization, model/provider routing, tool execution, approvals, jobs, quotas,
billing, and final decisions. This service only returns numerical embeddings and
ranking data. Treat every response as untrusted input and validate it in TypeScript.

## Run locally

Use Python 3.12:

```sh
cd python/ai-service
python -m venv .venv
. .venv/bin/activate  # Windows: .venv\\Scripts\\activate
python -m pip install --requirement requirements-dev.txt
export SOFIA_AI_SERVICE_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
uvicorn app:app --host 127.0.0.1 --port 8091
```

The first AI request may download model weights. This can use significant network,
disk, RAM, and CPU. Do not expose the service publicly. Use private networking,
TLS, secret management, resource limits, and request-rate limits in any deployment.

## API

- `GET /health`: liveness only; does not load model weights.
- `POST /v1/embeddings`: 1–64 non-empty texts, each at most 20,000 characters.
- `POST /v1/rerank`: one query and 1–64 non-empty documents.

AI endpoints require `Authorization: Bearer $SOFIA_AI_SERVICE_TOKEN`.
Authentication fails closed when the token is absent. Unknown JSON fields,
oversized requests, malformed model output, and non-finite numeric values are rejected.

## Validation

```sh
ruff check .
pytest -q
```

Tests use fake models and do not download model weights. This PR does not wire the
service into Sofia's Brain. Semantic-memory integration must be a separate,
versioned TypeScript adapter change with contract tests and measured quality/latency
before production use.
