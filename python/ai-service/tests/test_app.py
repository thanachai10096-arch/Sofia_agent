from fastapi.testclient import TestClient

from app import create_app


class FakeEmbedder:
    def encode(self, texts, *, normalize_embeddings=True):
        return [[float(len(text)), 1.0] for text in texts]


class FakeReranker:
    def predict(self, pairs):
        return [float(len(document)) for _, document in pairs]


def make_client(monkeypatch):
    monkeypatch.setenv("SOFIA_AI_SERVICE_TOKEN", "test-token")
    app = create_app(embedder_factory=FakeEmbedder, reranker_factory=FakeReranker)
    return TestClient(app)


def test_health_is_available_without_model_load(monkeypatch):
    monkeypatch.delenv("SOFIA_AI_SERVICE_TOKEN", raising=False)
    client = TestClient(create_app(embedder_factory=FakeEmbedder, reranker_factory=FakeReranker))
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_embeddings_requires_service_token(monkeypatch):
    client = make_client(monkeypatch)
    response = client.post("/v1/embeddings", json={"texts": ["hello"]})
    assert response.status_code == 401


def test_embeddings_returns_vectors_and_dimensions(monkeypatch):
    client = make_client(monkeypatch)
    response = client.post(
        "/v1/embeddings",
        headers={"Authorization": "Bearer test-token"},
        json={"texts": ["hello", "sofia"]},
    )
    assert response.status_code == 200
    assert response.json()["dimensions"] == 2
    assert len(response.json()["embeddings"]) == 2


def test_rerank_orders_longer_document_first(monkeypatch):
    client = make_client(monkeypatch)
    response = client.post(
        "/v1/rerank",
        headers={"Authorization": "Bearer test-token"},
        json={"query": "agent", "documents": ["short", "a longer document"]},
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["index"] == 1


def test_rejects_whitespace_text(monkeypatch):
    client = make_client(monkeypatch)
    response = client.post(
        "/v1/embeddings",
        headers={"Authorization": "Bearer test-token"},
        json={"texts": ["   "]},
    )
    assert response.status_code == 422
