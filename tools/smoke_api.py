import asyncio
from uuid import uuid4

import httpx
from accremind_api.main import create_app


def headers(project_id: str, *, role: str = "developer") -> dict[str, str]:
    return {
        "X-Organization-Id": "smoke-org",
        "X-Team-Id": "smoke-team",
        "X-Project-Id": project_id,
        "X-Actor-Id": f"smoke-{role}",
        "X-Actor-Role": role,
    }


async def main() -> None:
    suffix = uuid4().hex[:12]
    project_id = f"smoke-project-{suffix}"
    other_project_id = f"smoke-other-{suffix}"
    submit = {
        "task_id": f"smoke-task-{suffix}",
        "candidate": {
            "title": "React request race condition",
            "problem": "An older response overwrites the latest filtered result.",
            "context": "React filter changes can issue overlapping requests.",
            "solution": "Cancel stale requests or only commit the latest sequence number.",
            "failed_attempts": [],
            "validation": {
                "method": "Resolve deliberately reordered responses.",
                "result": "Only the latest response is rendered.",
            },
            "applicability": {
                "domains": ["frontend"],
                "technologies": ["React", "TypeScript"],
                "project_ids": [project_id],
                "phases": ["troubleshoot"],
                "triggers": ["request race"],
            },
        },
        "used_experience_ids": [],
        "redaction_confirmed": True,
        "idempotency_key": f"smoke-submit-{suffix}",
    }
    recall = {
        "task_id": f"smoke-recall-{suffix}",
        "query": "React request race",
        "requested_scope": {
            "organization_id": "smoke-org",
            "team_id": "smoke-team",
            "project_id": project_id,
        },
    }

    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/ready")).status_code == 200
        submitted = await client.post(
            "/api/v1/candidates", json=submit, headers=headers(project_id)
        )
        submitted.raise_for_status()
        candidate_id = submitted.json()["candidate_id"]

        prepared = await client.post(
            f"/api/v1/candidates/{candidate_id}/prepare-review",
            headers=headers(project_id, role="reviewer"),
        )
        prepared.raise_for_status()
        published = await client.post(
            f"/api/v1/candidates/{candidate_id}/publish",
            headers=headers(project_id, role="reviewer"),
        )
        published.raise_for_status()
        experience_id = published.json()["experience_id"]

        recalled = await client.post(
            "/api/v1/retrieval/recall", json=recall, headers=headers(project_id)
        )
        recalled.raise_for_status()
        assert experience_id in {item["experience_id"] for item in recalled.json()["items"]}

        hidden = await client.get(
            f"/api/v1/experiences/{experience_id}", headers=headers(other_project_id)
        )
        assert hidden.status_code == 404

    print(
        {
            "status": "ok",
            "candidate_id": candidate_id,
            "experience_id": experience_id,
            "cross_project_status": hidden.status_code,
        }
    )


if __name__ == "__main__":
    asyncio.run(main())
