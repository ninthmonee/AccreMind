import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from accremind_api.database import Base, get_session
from accremind_api.main import create_app
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[3]
DEVELOPER_HEADERS = {
    "X-Organization-Id": "acme",
    "X-Team-Id": "frontend",
    "X-Project-Id": "commerce-web",
    "X-Actor-Id": "developer-1",
    "X-Actor-Role": "developer",
}
REVIEWER_HEADERS = {
    **DEVELOPER_HEADERS,
    "X-Actor-Id": "reviewer-1",
    "X-Actor-Role": "reviewer",
}


@pytest.fixture
def client() -> Iterator[TestClient]:
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine.sync_engine, "connect")
    def enable_sqlite_foreign_keys(dbapi_connection: object, _: object) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def create_schema() -> None:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    asyncio.run(create_schema())
    app = create_app()
    app.dependency_overrides[get_session] = override_session
    with TestClient(app) as test_client:
        yield test_client
    asyncio.run(engine.dispose())


def submit_payload() -> dict[str, object]:
    return json.loads((ROOT / "schemas/examples/experience-submit.valid.json").read_text())


def recall_payload() -> dict[str, object]:
    return json.loads((ROOT / "schemas/examples/recall-request.valid.json").read_text())


def test_health_and_database_readiness(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").json() == {"status": "ready"}


def test_candidate_publish_and_recall_loop(client: TestClient) -> None:
    submitted = client.post("/api/v1/candidates", json=submit_payload(), headers=DEVELOPER_HEADERS)
    assert submitted.status_code == 201
    candidate_id = submitted.json()["candidate_id"]
    assert submitted.json()["status"] == "submitted"

    empty_recall = client.post(
        "/api/v1/retrieval/recall", json=recall_payload(), headers=DEVELOPER_HEADERS
    )
    assert empty_recall.status_code == 200
    assert empty_recall.json()["items"] == []

    forbidden = client.post(
        f"/api/v1/candidates/{candidate_id}/prepare-review", headers=DEVELOPER_HEADERS
    )
    assert forbidden.status_code == 403

    prepared = client.post(
        f"/api/v1/candidates/{candidate_id}/prepare-review", headers=REVIEWER_HEADERS
    )
    assert prepared.status_code == 200
    assert prepared.json()["status"] == "ready_for_review"

    published = client.post(f"/api/v1/candidates/{candidate_id}/publish", headers=REVIEWER_HEADERS)
    assert published.status_code == 200
    experience_id = published.json()["experience_id"]
    assert published.json()["current"]["version"] == 1

    recalled = client.post(
        "/api/v1/retrieval/recall", json=recall_payload(), headers=DEVELOPER_HEADERS
    )
    assert recalled.status_code == 200
    assert recalled.json()["items"][0]["experience_id"] == experience_id


def test_candidate_submit_is_idempotent(client: TestClient) -> None:
    first = client.post("/api/v1/candidates", json=submit_payload(), headers=DEVELOPER_HEADERS)
    second = client.post("/api/v1/candidates", json=submit_payload(), headers=DEVELOPER_HEADERS)
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["candidate_id"] == second.json()["candidate_id"]


def test_project_token_cannot_recall_another_project(client: TestClient) -> None:
    payload = recall_payload()
    payload["requested_scope"] = {
        "organization_id": "acme",
        "team_id": "frontend",
        "project_id": "another-project",
    }
    response = client.post("/api/v1/retrieval/recall", json=payload, headers=DEVELOPER_HEADERS)
    assert response.status_code == 403
