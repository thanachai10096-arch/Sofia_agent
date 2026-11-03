import os

import pytest
from fastapi.testclient import TestClient

from app import create_app


class FakeEmbedder:
    def encode(self, texts, *, normalize_embeddings=True):
        return [[float(index + 1), 0.5] for index, _ in enumerate(texts)]


class FakeReranker:
    def predict(self, pairs):
        return [float(len(document)) for _, document in pairs]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("SOFIA_AI_SERVICE_TOKEN", "test-secret")
    app = create_app(FakeEmbedder, FakeReranker)
    return TestClient(app)


def auth():
    return {"Authorization": "Bearer test-secret"}


def test_health_does_not_require_auth_or_load_models(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Basic test-secret"},
        {"Authorization": "Bearer"},
        {"Authorization": "Bearer wrong"},
    ],
)
def test_ai_endpoints_reject_missing_or_invalid_auth(client, headers):
    response = client.post(
        "/v1/embeddings", json={"texts": ["hello"]}, headers=headers
    )
    assert response.status_code == 401


def test_ai_endpoints_fail_closed_without_configured_token(monkeypatch):
    monkeypatch.delenv("SOFIA_AI_SERVICE_TOKEN", raising=False)
    client = TestClient(create_app(FakeEmbedder, FakeReranker))
    response = client.post(
        "/v1/embeddings",
        json={"texts": ["hello"]},
        headers={"Authorization": "Bearer anything"},
    )
    assert response.status_code == 503


def test_embeddings_returns_bounded_vectors(client):
    response = client.post(
        "/v1/embeddings",
        json={"texts": ["alpha", "beta"], "normalize": True},
        headers=auth(),
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["dimensions"] == 2
    assert len(payload["embeddings"]) == 2


def test_rerank_returns_descending_scores_and_original_indices(client):
    response = client.post(
        "/v1/rerank",
        json={"query": "q", "documents": ["a", "longer"]},
        headers=auth(),
    )
    assert response.status_code == 200
    assert [item["index"] for item in response.json()["results"]] == [1, 0]


@pytest.mark.parametrize(
    "payload",
    [
        {"texts": []},
        {"texts": ["   "]},
        {"texts": ["x" * 20_001]},
        {"texts": ["ok"], "unexpected": True},
    ],
)
def test_embeddings_reject_invalid_payloads(client, payload):
    response = client.post(
        "/v1/embeddings", json=payload, headers=auth()
    )
    assert response.status_code in {413, 422}


def test_embeddings_reject_more_than_64_texts(client):
    response = client.post(
        "/v1/embeddings",
        json={"texts": [f"item-{index}" for index in range(65)]},
        headers=auth(),
    )
    assert response.status_code == 422


def test_rerank_rejects_empty_documents(client):
    response = client.post(
        "/v1/rerank",
        json={"query": "q", "documents": []},
        headers=auth(),
    )
    assert response.status_code == 422


def test_model_output_with_non_finite_values_is_rejected(monkeypatch):
    class BadEmbedder:
        def encode(self, texts, *, normalize_embeddings=True):
            return [[float("nan")]]

    monkeypatch.setenv("SOFIA_AI_SERVICE_TOKEN", "test-secret")
    client = TestClient(create_app(BadEmbedder, FakeReranker))
    response = client.post(
        "/v1/embeddings",
        json={"texts": ["hello"]},
        headers=auth(),
    )
    assert response.status_code == 502


def test_reranker_output_with_wrong_length_is_rejected(monkeypatch):
    class BadReranker:
        def predict(self, pairs):
            return []

    monkeypatch.setenv("SOFIA_AI_SERVICE_TOKEN", "test-secret")
    client = TestClient(create_app(FakeEmbedder, BadReranker))
    response = client.post(
        "/v1/rerank",
        json={"query": "q", "documents": ["doc"]},
        headers=auth(),
    )
    assert response.status_code == 502
