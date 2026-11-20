"""Isolated AI utility service for embeddings and semantic reranking.

The TypeScript Sofia Core remains authoritative for identity, permissions, tools,
execution policy, job state, and billing. This service only returns ranked data.
"""
from __future__ import annotations

import hmac
import os
from functools import lru_cache
from typing import Annotated, Protocol

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

MAX_TEXT_CHARS = 20_000
MAX_ITEMS = 64


class Embedder(Protocol):
    def encode(self, texts: list[str], *, normalize_embeddings: bool = True): ...


class Reranker(Protocol):
    def predict(self, pairs: list[tuple[str, str]]): ...


@lru_cache(maxsize=1)
def _load_embedder() -> Embedder:
    from sentence_transformers import SentenceTransformer

    model_name = os.getenv("SOFIA_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    return SentenceTransformer(model_name)


@lru_cache(maxsize=1)
def _load_reranker() -> Reranker:
    from sentence_transformers import CrossEncoder

    model_name = os.getenv(
        "SOFIA_RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2"
    )
    return CrossEncoder(model_name)


class EmbeddingRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_ITEMS)
    normalize: bool = True


class EmbeddingResponse(BaseModel):
    model: str
    dimensions: int
    embeddings: list[list[float]]


class RerankRequest(BaseModel):
    query: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    documents: list[str] = Field(min_length=1, max_length=MAX_ITEMS)


class RankedDocument(BaseModel):
    index: int
    score: float


class RerankResponse(BaseModel):
    model: str
    results: list[RankedDocument]


def _validate_texts(texts: list[str]) -> None:
    if any(not text.strip() for text in texts):
        raise HTTPException(status_code=422, detail="Texts must not be empty or whitespace.")
    if any(len(text) > MAX_TEXT_CHARS for text in texts):
        raise HTTPException(status_code=413, detail="A text exceeds the maximum character limit.")


def _authorize(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = os.getenv("SOFIA_AI_SERVICE_TOKEN", "")
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI service authentication is not configured.",
        )
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if (
        not authorization
        or not authorization.startswith("Bearer ")
        or not hmac.compare_digest(supplied, expected)
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized.")


def create_app(
    embedder_factory=_load_embedder,
    reranker_factory=_load_reranker,
) -> FastAPI:
    app = FastAPI(title="Sofia AI Service", version="0.1.0", docs_url=None, redoc_url=None)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(
        "/v1/embeddings",
        response_model=EmbeddingResponse,
        dependencies=[Depends(_authorize)],
    )
    def embeddings(request: EmbeddingRequest) -> EmbeddingResponse:
        _validate_texts(request.texts)
        model = embedder_factory()
        vectors = model.encode(request.texts, normalize_embeddings=request.normalize)
        result = [[float(value) for value in vector] for vector in vectors]
        if not result or not result[0]:
            raise HTTPException(status_code=502, detail="Embedding model returned an empty result.")
        if any(len(vector) != len(result[0]) for vector in result):
            raise HTTPException(status_code=502, detail="Embedding dimensions are inconsistent.")
        return EmbeddingResponse(
            model=os.getenv("SOFIA_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
            dimensions=len(result[0]),
            embeddings=result,
        )

    @app.post(
        "/v1/rerank",
        response_model=RerankResponse,
        dependencies=[Depends(_authorize)],
    )
    def rerank(request: RerankRequest) -> RerankResponse:
        _validate_texts([request.query, *request.documents])
        model = reranker_factory()
        scores = model.predict([(request.query, document) for document in request.documents])
        ranked = sorted(
            (RankedDocument(index=index, score=float(score)) for index, score in enumerate(scores)),
            key=lambda item: item.score,
            reverse=True,
        )
        return RerankResponse(
            model=os.getenv("SOFIA_RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2"),
            results=ranked,
        )

    return app


app = create_app()
