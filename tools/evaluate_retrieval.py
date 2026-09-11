"""Versioned synthetic smoke dataset against real PostgreSQL FTS, not a P0 quality claim."""

import asyncio
import json
from pathlib import Path
from uuid import uuid4

from accremind_api.application import prepare_candidate, publish_candidate, submit_candidate
from accremind_api.auth import ActorRole, AuthContext
from accremind_api.database import SessionFactory
from accremind_api.retriever import retrieve
from accremind_contracts import ExperienceSubmitRequest, RecallRequest, Scope
from accremind_retriever_agent import metrics

ROOT = Path(__file__).resolve().parents[1]


async def main():
    dataset = json.loads((ROOT / "evals/retrieval-smoke.json").read_text())
    auth = AuthContext(
        "evaluator", ActorRole.REVIEWER, Scope(organization_id="eval-" + uuid4().hex[:12])
    )
    identifiers = {}
    async with SessionFactory() as session:
        for case in dataset["cases"]:
            request = ExperienceSubmitRequest(
                task_id=case["id"].encode().hex(),
                candidate={
                    "title": case["title"],
                    "problem": case["problem"],
                    "solution": case["solution"],
                    "context": "Synthetic regression fixture.",
                    "validation": {
                        "method": "Fixture review",
                        "result": "Expected guidance recorded",
                    },
                    "applicability": {},
                },
                redaction_confirmed=True,
                idempotency_key=uuid4().hex,
            )
            candidate = await submit_candidate(session, request, auth)
            await prepare_candidate(session, candidate.candidate_id, auth)
            experience = await publish_candidate(session, candidate.candidate_id, auth)
            identifiers[case["id"]] = experience.experience_id
        results = []
        for case in dataset["cases"]:
            for query in case["queries"]:
                pack = await retrieve(
                    session, RecallRequest(task_id="evaluation", query=query), auth
                )
                score = metrics({identifiers[case["id"]]}, [i.experience_id for i in pack.items])
                results.append({"case": case["id"], "query": query, **score})
        await session.commit()
    report = {
        "dataset_kind": dataset["dataset_kind"],
        "query_count": len(results),
        "recall_at_5": sum(r["recall_at_k"] for r in results) / len(results),
        "mrr_at_5": sum(r["reciprocal_rank"] for r in results) / len(results),
        "results": results,
    }
    (ROOT / "evals/retrieval-smoke-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print({key: value for key, value in report.items() if key != "results"})
    assert report["recall_at_5"] >= 0.85


if __name__ == "__main__":
    asyncio.run(main())
