"""Benchmark Sofia semantic retrieval against lexical and reranked retrieval.

Run against an explicitly configured private AI service. This script downloads no
models and records no secrets; it only sends the small local benchmark fixture.
"""
from __future__ import annotations

import json
import math
import os
import statistics
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
CASES_PATH = ROOT / "memory-cases.json"


def request_json(
    base_url: str, token: str, route: str, body: dict[str, Any]
) -> tuple[dict[str, Any], float]:
    payload = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + route,
        data=payload,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.loads(response.read().decode("utf-8"))
    return result, (time.perf_counter() - started) * 1000


def is_allowed_service_url(value: str) -> bool:
    try:
        parsed_url = urlparse(value)
        _ = parsed_url.port
    except ValueError:
        return False
    if (
        not parsed_url.hostname
        or parsed_url.username is not None
        or parsed_url.password is not None
    ):
        return False
    if parsed_url.scheme == "https":
        return True
    return parsed_url.scheme == "http" and parsed_url.hostname in {
        "localhost",
        "127.0.0.1",
        "::1",
    }


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else -1.0


def metrics(ranked_ids: list[str], relevant_ids: set[str], k: int = 3) -> dict[str, float]:
    top = ranked_ids[:k]
    hits = sum(item in relevant_ids for item in top)
    reciprocal_rank = next(
        (1.0 / index for index, item in enumerate(ranked_ids, start=1) if item in relevant_ids),
        0.0,
    )
    return {
        f"recall@{k}": hits / len(relevant_ids) if relevant_ids else 0.0,
        "mrr": reciprocal_rank,
    }


def main() -> int:
    base_url = os.getenv("SOFIA_AI_SERVICE_URL", "").strip()
    token = os.getenv("SOFIA_AI_SERVICE_TOKEN", "")
    if not base_url or not token:
        print("Set SOFIA_AI_SERVICE_URL and SOFIA_AI_SERVICE_TOKEN.", file=sys.stderr)
        return 2
    if not is_allowed_service_url(base_url):
        print(
            "Refusing AI service URL: HTTPS is required except for localhost HTTP.",
            file=sys.stderr,
        )
        return 2

    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    embed_ms: list[float] = []
    rerank_ms: list[float] = []
    semantic_scores: list[dict[str, float]] = []
    rerank_scores: list[dict[str, float]] = []
    for case in cases:
        documents = case["documents"]
        texts = [case["query"], *[document["text"] for document in documents]]
        embedded, elapsed = request_json(
            base_url, token, "/v1/embeddings", {"texts": texts, "normalize": True}
        )
        embed_ms.append(elapsed)
        vectors = embedded.get("embeddings", [])
        if len(vectors) != len(texts) or not vectors or any(
            not isinstance(vector, list) or len(vector) != embedded.get("dimensions")
            for vector in vectors
        ):
            raise ValueError(f"Malformed embeddings response for case {case['id']}")
        ranked = sorted(
            zip(documents, vectors[1:], strict=True),
            key=lambda item: cosine(vectors[0], item[1]),
            reverse=True,
        )
        relevant = {document["id"] for document in documents if document["relevant"]}
        semantic_scores.append(metrics([item[0]["id"] for item in ranked], relevant))

        reranked, elapsed = request_json(
            base_url,
            token,
            "/v1/rerank",
            {"query": case["query"], "documents": [document["text"] for document in documents]},
        )
        rerank_ms.append(elapsed)
        results = reranked.get("results", [])
        if any(
            not isinstance(item.get("index"), int)
            or not 0 <= item["index"] < len(documents)
            for item in results
        ):
            raise ValueError(f"Malformed reranker indices for case {case['id']}")
        rerank_scores.append(
            metrics([documents[item["index"]]["id"] for item in results], relevant)
        )

    def avg(key: str, rows: list[dict[str, float]]) -> float:
        return statistics.mean(row[key] for row in rows)

    report = {
        "cases": len(cases),
        "embedding_latency_ms_mean": round(statistics.mean(embed_ms), 2),
        "embedding_latency_ms_p95_observed": round(
            sorted(embed_ms)[math.ceil(0.95 * len(embed_ms)) - 1], 2
        ),
        "rerank_latency_ms_mean": round(statistics.mean(rerank_ms), 2),
        "semantic_recall_at_3": round(avg("recall@3", semantic_scores), 3),
        "reranked_recall_at_3": round(avg("recall@3", rerank_scores), 3),
        "semantic_mrr": round(avg("mrr", semantic_scores), 3),
        "reranked_mrr": round(avg("mrr", rerank_scores), 3),
        "note": (
            "Small smoke benchmark only; expand and label cases from real project tasks "
            "before production decisions."
        ),
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
