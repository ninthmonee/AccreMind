import math
from typing import Protocol

import httpx


class EmbeddingProvider(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class OpenAICompatibleEmbedding:
    def __init__(self, *, base_url: str, api_key: str, model: str, dimensions: int = 1536):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.dimensions = dimensions

    async def embed(self, texts: list[str]) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                self.base_url + "/embeddings",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={"input": texts, "model": self.model, "dimensions": self.dimensions},
            )
            response.raise_for_status()
            values = sorted(response.json()["data"], key=lambda item: item["index"])
        if [v["index"] for v in values] != list(range(len(texts))):
            raise ValueError("embedding response indices mismatch")
        vectors = [v["embedding"] for v in values]
        for vector in vectors:
            if len(vector) != self.dimensions or not all(math.isfinite(v) for v in vector):
                raise ValueError("invalid embedding dimension or values")
            if not any(v != 0 for v in vector):
                raise ValueError("zero embedding is invalid for cosine retrieval")
        return vectors
