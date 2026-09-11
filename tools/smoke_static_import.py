"""Real PostgreSQL smoke: scoped RLS, atomic imports and concurrent idempotency.

Run after `make migrate`. Uses a unique smoke organization; never touches existing content.
"""

import asyncio
import json
from pathlib import Path
from uuid import uuid4

import httpx
from accremind_api.database import SessionFactory
from accremind_api.main import create_app
from accremind_contracts import Scope, StaticExperienceDocument
from accremind_static_experience.markdown import parse_markdown, render_markdown
from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]


async def main() -> None:
    organization = "static-smoke-" + uuid4().hex[:12]
    headers = {
        "X-Organization-Id": organization,
        "X-Team-Id": "frontend",
        "X-Project-Id": "web",
        "X-Actor-Id": "developer",
    }
    reviewer = {**headers, "X-Actor-Id": "reviewer", "X-Actor-Role": "reviewer"}
    draft = json.loads((ROOT / "schemas/examples/experience-submit.valid.json").read_text())[
        "candidate"
    ]
    document = StaticExperienceDocument(
        file_id="race",
        owner_id="developer",
        content_hash="0" * 64,
        experience=draft,
        scope=Scope(organization_id=organization, team_id="frontend", project_id="web"),
    )
    prefix = "/api/v1/static-import"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()), base_url="http://test"
    ) as client:

        async def plan(content):
            files = [{"filename": "race.md", "content": content}]
            response = await client.post(
                prefix + "/preview", json={"files": files}, headers=headers
            )
            response.raise_for_status()
            return {
                "files": files,
                "preview_hash": response.json()["preview_hash"],
                "idempotency_key": uuid4().hex,
                "redaction_confirmed": True,
            }

        async def publish(candidate_id):
            response = await client.post(
                f"/api/v1/candidates/{candidate_id}/prepare-review", headers=reviewer
            )
            response.raise_for_status()
            response = await client.post(
                f"/api/v1/candidates/{candidate_id}/publish", headers=reviewer
            )
            response.raise_for_status()
            return response.json()

        request = await plan(render_markdown(document, "Original Markdown."))
        first, retry = await asyncio.gather(
            *[client.post(prefix + "/commit", json=request, headers=headers) for _ in range(2)]
        )
        first.raise_for_status()
        retry.raise_for_status()
        assert first.json() == retry.json()
        candidate_id = first.json()["candidate_ids"][0]
        published = await publish(candidate_id)
        experience_id = published["experience_id"]
        exported = await client.get(prefix + "/export/" + experience_id, headers=headers)
        exported.raise_for_status()
        document, body = parse_markdown(exported.text)
        document.experience.solution += " Keep the sequence monotonic."
        update = await plan(render_markdown(document, body + " Updated."))
        concurrent = {**update, "idempotency_key": uuid4().hex}
        results = await asyncio.gather(
            *[
                client.post(prefix + "/commit", json=value, headers=headers)
                for value in (update, concurrent)
            ]
        )
        assert sorted(r.status_code for r in results) == [200, 409], [r.text for r in results]
        accepted = next(r.json() for r in results if r.status_code == 200)
        updated = await publish(accepted["candidate_ids"][0])
        assert updated["experience_id"] == experience_id
        assert updated["current"]["version"] == 2
        for hidden_headers in (
            {**headers, "X-Project-Id": "other"},
            {**headers, "X-Team-Id": "other"},
            {**headers, "X-Organization-Id": "other"},
        ):
            response = await client.get(prefix + "/export/" + experience_id, headers=hidden_headers)
            assert response.status_code == 404

    async with SessionFactory() as session:
        role = (
            await session.execute(
                text("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            )
        ).one()
        assert tuple(role) == (False, False)
        assert await session.scalar(text("SELECT count(*) FROM static_files")) == 0
        assert await session.scalar(text("SELECT count(*) FROM import_receipts")) == 0
        for key, value in {
            "organization_id": organization,
            "team_id": "frontend",
            "project_id": "web",
            "personal_owner_id": "",
        }.items():
            await session.execute(
                text("SELECT set_config(:key, :value, true)"), {"key": "app." + key, "value": value}
            )
        assert await session.scalar(text("SELECT count(*) FROM candidates")) == 2
        assert await session.scalar(text("SELECT count(*) FROM static_files")) == 1
        versions = (
            await session.execute(
                text("SELECT version, markdown_body FROM experience_versions ORDER BY version")
            )
        ).all()
        assert versions == [(1, "Original Markdown."), (2, "Original Markdown. Updated.")]
    print(
        {
            "status": "ok",
            "concurrent_replay": "same_candidate",
            "concurrent_update": [200, 409],
            "immutable_versions": [1, 2],
            "rls": "fail_closed",
            "organization": organization,
        }
    )


if __name__ == "__main__":
    asyncio.run(main())
