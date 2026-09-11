from accremind_contracts import (
    ExperienceFeedbackRequest,
    ExperienceSubmitRequest,
    TaskCompleteRequest,
    TaskCompleteResult,
)
from accremind_static_experience.markdown import scan_sensitive
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .application import (
    apply_database_scope,
    assert_can_access,
    load_experience,
    new_id,
    record_scope,
    submit_candidate,
)
from .auth import AuthContext
from .models import AuditEventRecord, FeedbackRecord, JobRecord, OperationRecord, RetrievalRecord
from .static_import import digest, lock_keys


async def operation(session, auth, kind, request):
    await apply_database_scope(session, auth)
    key = digest([auth.scope.model_dump(), auth.actor_id, kind, request.idempotency_key])
    await lock_keys(session, [key])
    existing = await session.get(OperationRecord, key)
    if existing:
        assert_can_access(auth, record_scope(existing))
        if existing.request_hash != digest(request.model_dump()):
            raise HTTPException(409, "idempotency key reused with different content")
    return key, existing


def receipt(session, auth, kind, key, request, result):
    session.add(
        OperationRecord(
            key=key,
            id=new_id("OP"),
            actor_id=auth.actor_id,
            kind=kind,
            request_hash=digest(request.model_dump()),
            result=result,
            **auth.scope.model_dump(),
        )
    )


async def feedback(
    session: AsyncSession, request: ExperienceFeedbackRequest, auth: AuthContext
) -> dict:
    key, existing = await operation(session, auth, "feedback", request)
    if existing:
        return existing.result
    if request.note and scan_sensitive(request.note):
        raise HTTPException(422, "feedback contains sensitive data")
    retrieval = await session.get(RetrievalRecord, request.retrieval_id)
    if retrieval is None:
        raise HTTPException(404, "retrieval not found")
    assert_can_access(auth, record_scope(retrieval))
    if (
        retrieval.task_id != request.task_id
        or retrieval.actor_id != auth.actor_id
        or not any(
            i["experience_id"] == request.experience_id
            and i["version"] == request.experience_version
            for i in retrieval.items
        )
    ):
        raise HTTPException(422, "feedback must reference this actor's task and recalled version")
    await load_experience(session, request.experience_id, auth)
    result = {"feedback_id": new_id("FB"), "accepted": True}
    session.add(
        FeedbackRecord(
            id=result["feedback_id"],
            actor_id=auth.actor_id,
            task_id=request.task_id,
            retrieval_id=request.retrieval_id,
            experience_id=request.experience_id,
            version=request.experience_version,
            kind=request.kind,
            note=request.note,
            **auth.scope.model_dump(),
        )
    )
    if request.kind in {"incorrect", "outdated", "conflicting"}:
        session.add(
            JobRecord(
                id="review:" + result["feedback_id"],
                kind="experience.review",
                entity_id=request.experience_id,
                scope=auth.scope.model_dump(mode="json"),
            )
        )
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="feedback.accepted",
            entity_type="feedback",
            entity_id=result["feedback_id"],
        )
    )
    receipt(session, auth, "feedback", key, request, result)
    await session.flush()
    return result


async def complete(
    session: AsyncSession, request: TaskCompleteRequest, auth: AuthContext
) -> TaskCompleteResult:
    key, existing = await operation(session, auth, "task_complete", request)
    if existing:
        return TaskCompleteResult.model_validate(existing.result)
    if scan_sensitive(request.model_dump_json()):
        raise HTTPException(422, "task completion contains sensitive data")
    # Sort feedback idempotency locks to avoid deadlocks across concurrent batches.
    for entry in sorted(
        request.feedback,
        key=lambda f: digest(
            [auth.scope.model_dump(), auth.actor_id, "feedback", f.idempotency_key]
        ),
    ):
        await feedback(session, entry, auth)
    candidate_ids = []
    for i, draft in enumerate(request.candidates):
        candidate = await submit_candidate(
            session,
            ExperienceSubmitRequest(
                task_id=request.task_id,
                candidate=draft,
                redaction_confirmed=True,
                idempotency_key="completion:" + digest([key, i]),
            ),
            auth,
        )
        candidate_ids.append(candidate.candidate_id)
    result = TaskCompleteResult(
        completion_id=new_id("DONE"),
        candidate_ids=candidate_ids,
        feedback_accepted=len(request.feedback),
    )
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="task.completed",
            entity_type="task",
            entity_id=result.completion_id,
            metadata_json={
                "candidate_count": len(candidate_ids),
                "verified": request.outcome.verified,
            },
        )
    )
    receipt(session, auth, "task_complete", key, request, result.model_dump())
    await session.flush()
    return result
