"""Verify real pgvector execution and scope filtering with deterministic test vectors."""

import asyncio
from uuid import uuid4

from accremind_api.application import prepare_candidate, publish_candidate, submit_candidate
from accremind_api.auth import ActorRole, AuthContext
from accremind_api.database import SessionFactory
from accremind_api.models import ExperienceVersionRecord
from accremind_api.retriever import embed_version, retrieve
from accremind_contracts import ExperienceSubmitRequest, RecallRequest, Scope
from sqlalchemy import select, text


class FixtureEmbedding:
    async def embed(self, texts):
        return [[1.0] + [0.0] * 1535 for _ in texts]


async def main():
    org = "vector-smoke-" + uuid4().hex[:10]
    provider = FixtureEmbedding()
    async with SessionFactory() as session:
        ids = []
        for project in ("a", "b"):
            auth = AuthContext(
                "reviewer",
                ActorRole.REVIEWER,
                Scope(organization_id=org, team_id="team", project_id=project),
            )
            submitted = await submit_candidate(
                session,
                ExperienceSubmitRequest(
                    task_id="vector",
                    idempotency_key="vector-" + project,
                    redaction_confirmed=True,
                    candidate={
                        "title": "React request ordering",
                        "problem": "Previous calls overwrite new results",
                        "context": "React client",
                        "solution": "Cancel old requests with AbortController",
                        "validation": {"method": "reverse calls", "result": "latest wins"},
                        "applicability": {},
                    },
                ),
                auth,
            )
            await prepare_candidate(session, submitted.candidate_id, auth)
            experience = await publish_candidate(session, submitted.candidate_id, auth)
            version = await session.scalar(
                select(ExperienceVersionRecord).where(
                    ExperienceVersionRecord.experience_id == experience.experience_id
                )
            )
            assert await embed_version(session, version, provider)
            assert await embed_version(session, version, provider)
            ids.append(experience.experience_id)
        auth = AuthContext(
            "reviewer",
            ActorRole.REVIEWER,
            Scope(organization_id=org, team_id="team", project_id="a"),
        )
        request = RecallRequest(task_id="vector", query="stale ajax concurrency")
        await session.execute(text("SET LOCAL enable_seqscan = off"))
        pack = await retrieve(session, request, auth, provider)
        assert [i.experience_id for i in pack.items] == [ids[0]], pack
        await session.execute(text("SET LOCAL enable_indexscan = off"))
        await session.execute(text("SET LOCAL enable_seqscan = on"))
        exact = await retrieve(session, request, auth, provider)
        assert [i.experience_id for i in exact.items] == [i.experience_id for i in pack.items]
        await session.commit()
    print({"status": "ok", "test_vectors": True, "scope_filtered": True, "hnsw_exact_agree": True})


if __name__ == "__main__":
    asyncio.run(main())
