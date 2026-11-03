""""Optional, isolated AI utility service for Sofia.

The TypeScript control plane remains authoritative for identity, permissions,
agent execution, tools, jobs, and billing. This service only returns data.
"""
from __future__ import annotations

import hmac
import json
import logging
import math
import os
import time
import uuid
from functools import lru_cache
from typing import Annotated, Protocol

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import JSONResponse

MAX_TEXT_CHARS = 20_000
MAX_ITEMS = 64
MAX_REQUEST_BYTES = 512 * 1024
logger = logging.getLogger("sofia.ai_service")


class _RequestBodyTooLarge(Exception):
    pass


class RequestIdLoggingMiddleware:
    """Attach a validated correlation ID and emit payload-free access logs."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        supplied_id = headers.get(b"x-request-id", b"").decode("ascii", errors="ignore")
        try:
            request_id = str(uuid.UUID(supplied_id))
        except (ValueError, AttributeError):
            request_id = str(uuid.uuid4())

        started = time.perf_counter()
        status_code = 500

        async def correlated_send(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                response_headers = [
                    (key, value)
                    for key, value in message.get("headers", [])
                    if key.lower() != b"x-request-id"
                ]
                response_headers.append((b"x-request-id", request_id.encode("ascii")))
                message = {**message, "headers": response_headers}
            await send(message)

        try:
            await self.app(scope, receive, correlated_send)
        finally:
            # Never log authorization headers, request bodies, query strings,
            # model output, or exception text. Keep this safe for user content.
            logger.info(
                json.dumps(
                    {
                        "event": "http_request",
                        "request_id": request_id,
                        "method": scope.get("method", ""),
                        "path": scope.get("path", ""),
                        "status_code": status_code,
                        "duration_ms": round((time.perf_counter() - started) * 1000, 2),
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
            )


class RequestBodyLimitMiddleware:
    """Enforce a hard byte limit before FastAPI parses request JSON."""

    def __init__(self, app, max_bytes: int = MAX_REQUEST_BYTES):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") not in {"/v1/embeddings", "/v1/rerank"}
        ):
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except ValueError:
                declared_length = -1
            if declared_length > self.max_bytes:
                response = JSONResponse(
                    status_code=413,
                    content={"detail": "Request body exceeds the maximum byte limit."},
                )
                await response(scope, receive, send)
                return

        received_bytes = 0

        async def limited_receive():
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_bytes:
                    raise _RequestBodyTooLarge()
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _RequestBodyTooLarge:
            response = JSONResponse(
                status_code=413,
                content={"detail": "Request body exceeds the maximum byte limit."},
            )
            await response(scope, receive, send)


class Embedder(Protocol):
    def encode(self, texts: list[str], *, normalize_embeddings: bool = True): ...


class Reranker(Protocol):
    def predict(self, pairs: list[tuple[str, str]]): ...


@lru_cache(maxsize=1)
def _load_embedder() -> Embedder:
    from sentence_transformers import SentenceTransformer

    model_name = os.getenv(
        "SOFIA_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
    )
    return SentenceTransformer(model_name)


@lru_cache(maxsize=1)
def _load_reranker() -> Reranker:
    from sentence_transformers import CrossEncoder

    model_name = os.getenv(
        "SOFIA_RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2"
    )
    return CrossEncoder(model_name)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EmbeddingRequest(StrictModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_ITEMS)
    normalize: bool = True


class EmbeddingResponse(StrictModel):
    model: str
    dimensions: int
    embeddings: list[list[float]]


class RerankRequest(StrictModel):
    query: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    documents: list[str] = Field(min_length=1, max_length=MAX_ITEMS)


class RankedDocument(StrictModel):
    index: int
    score: float


class RerankResponse(StrictModel):
    model: str
    results: list[RankedDocument]


def _validate_texts(texts: list[str]) -> None:
    if any(not text.strip() for text in texts):
        raise HTTPException(
            status_code=422, detail="Texts must not be empty or whitespace."
        )
    if any(len(text) > MAX_TEXT_CHARS for text in texts):
        raise HTTPException(
            status_code=413, detail="A text exceeds the maximum character limit."
        )


def _authorize(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = os.getenv("SOFIA_AI_SERVICE_TOKEN", "")
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI service authentication is not configured.",
        )

    scheme, separator, supplied = (authorization or "").partition(" ")
    if (
        not separator
        or scheme.lower() != "bearer"
        or not supplied
        or not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized.",
        )


def create_app(
    embedder_factory=_load_embedder,
    reranker_factory=_load_reranker,
) -> FastAPI:
    app = FastAPI(
        title="Sofia AI Service",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(RequestBodyLimitMiddleware)
    # Add last so correlation headers/logging also cover body-limit responses.
    app.add_middleware(RequestIdLoggingMiddleware)

    @app.get("/health")
    def health() -> dict[str, str]:
        # Liveness only. Never load model weights on a health probe.
        return {"status": "ok"}

    @app.post(
        "/v1/embeddings",
        response_model=EmbeddingResponse,
        dependencies=[Depends(_authorize)],
    )
    def embeddings(request: EmbeddingRequest) -> EmbeddingResponse:
        _validate_texts(request.texts)
        try:
            model = embedder_factory()
        except Exception as error:
            raise HTTPException(
                status_code=503, detail="Embedding model is unavailable."
            ) from error

        try:
            vectors = model.encode(
                request.texts, normalize_embeddings=request.normalize
            )
            result = [[float(value) for value in vector] for vector in vectors]
        except Exception as error:
            raise HTTPException(
                status_code=502, detail="Embedding inference returned an invalid result."
            ) from error

        if len(result) != len(request.texts) or not result or not result[0]:
            raise HTTPException(
                status_code=502, detail="Embedding model returned an invalid result."
            )
        dimensions = len(result[0])
        if any(
            len(vector) != dimensions
            or any(not math.isfinite(value) for value in vector)
            for vector in result
        ):
            raise HTTPException(
                status_code=502,
                detail="Embedding model returned inconsistent or non-finite values.",
            )

        return EmbeddingResponse(
            model=os.getenv(
                "SOFIA_EMBEDDING_MODEL",
                "sentence-transformers/all-MiniLM-L6-v2",
            ),
            dimensions=dimensions,
            embeddings=result,
        )

    @app.post(
        "/v1/rerank",
        response_model=RerankResponse,
        dependencies=[Depends(_authorize)],
    )
    def rerank(request: RerankRequest) -> RerankResponse:
        _validate_texts([request.query, *request.documents])
        try:
            model = reranker_factory()
        except Exception as error:
            raise HTTPException(
                status_code=503, detail="Reranker model is unavailable."
            ) from error

        try:
            scores = model.predict(
                [(request.query, document) for document in request.documents]
            )
            values = [float(score) for score in scores]
        except Exception as error:
            raise HTTPException(
                status_code=502, detail="Reranker inference returned an invalid result."
            ) from error
        if len(values) != len(request.documents) or any(
            not math.isfinite(score) for score in values
        ):
            raise HTTPException(
                status_code=502,
                detail="Reranker returned an invalid or non-finite result.",
            )

        ranked = sorted(
            (
                RankedDocument(index=index, score=score)
                for index, score in enumerate(values)
            ),
            key=lambda item: item.score,
            reverse=True,
        )
        return RerankResponse(
            model=os.getenv(
                "SOFIA_RERANKER_MODEL",
                "cross-encoder/ms-marco-MiniLM-L-6-v2",
            ),
            results=ranked,
        )


    return app


app = create_app()
