from accremind_contracts import CandidateDraft, CandidateStatus, ExperienceStatus, Scope
from accremind_contracts.common import ContractModel
from accremind_experience_domain import CandidateAction, InvalidTransition, transition_candidate
from accremind_static_experience.markdown import scan_sensitive
from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import String, cast, select

from ..api_models import CandidateView, ExperienceView
from ..application import (
    apply_database_scope,
    candidate_view,
    experience_view,
    load_candidate,
    new_id,
)
from ..auth import ActorRole, require_reviewer
from ..models import (
    AuditEventRecord,
    CandidateRecord,
    ExperienceRecord,
    ExperienceVersionRecord,
    JobRecord,
)
from .candidates import Auth, Session

router = APIRouter(prefix="/api/v1", tags=["studio"])


def scope_query(query, model, auth):
    query = query.where(model.organization_id == auth.scope.organization_id)
    for key in ("team_id", "project_id", "personal_owner_id"):
        value = getattr(auth.scope, key)
        if value is not None or key == "personal_owner_id":
            query = query.where(getattr(model, key) == value)
    return query


@router.get("/candidates", response_model=list[CandidateView])
async def candidates(
    session: Session,
    auth: Auth,
    q: str = "",
    state: CandidateStatus | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
):
    await apply_database_scope(session, auth)
    query = scope_query(select(CandidateRecord), CandidateRecord, auth)
    if state:
        query = query.where(CandidateRecord.status == state)
    if q:
        query = query.where(cast(CandidateRecord.payload, String).ilike("%" + q + "%"))
    return [
        candidate_view(c)
        for c in (
            await session.scalars(
                query.order_by(CandidateRecord.created_at.desc()).offset(offset).limit(limit)
            )
        ).all()
    ]


@router.get("/experiences", response_model=list[ExperienceView])
async def experiences(
    session: Session,
    auth: Auth,
    q: str = "",
    state: ExperienceStatus | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
):
    await apply_database_scope(session, auth)
    query = scope_query(
        select(ExperienceRecord, ExperienceVersionRecord).join(
            ExperienceVersionRecord,
            (ExperienceRecord.id == ExperienceVersionRecord.experience_id)
            & (ExperienceRecord.current_version == ExperienceVersionRecord.version),
        ),
        ExperienceRecord,
        auth,
    )
    if state:
        query = query.where(ExperienceRecord.status == state)
    if q:
        query = query.where(cast(ExperienceVersionRecord.payload, String).ilike("%" + q + "%"))
    return [
        experience_view(e, v)
        for e, v in (
            await session.execute(
                query.order_by(ExperienceRecord.updated_at.desc()).offset(offset).limit(limit)
            )
        ).all()
    ]


@router.patch("/candidates/{candidate_id}", response_model=CandidateView)
async def edit_candidate(candidate_id: str, request: CandidateDraft, session: Session, auth: Auth):
    require_reviewer(auth)
    candidate = await load_candidate(session, candidate_id, auth, for_update=True)
    if candidate.status not in {"submitted", "ready_for_review"}:
        raise HTTPException(409, "candidate cannot be edited in current state")
    if scan_sensitive(request.model_dump_json()):
        raise HTTPException(422, "candidate contains sensitive data")
    if candidate.static_document:
        raise HTTPException(409, "static candidates must retain their imported snapshot")
    candidate.payload = request.model_dump(mode="json")
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="candidate.edited",
            entity_type="candidate",
            entity_id=candidate.id,
        )
    )
    await session.flush()
    return candidate_view(candidate)


@router.post("/candidates/{candidate_id}/reject", response_model=CandidateView)
async def reject(candidate_id: str, session: Session, auth: Auth):
    require_reviewer(auth)
    candidate = await load_candidate(session, candidate_id, auth, for_update=True)
    try:
        candidate.status = transition_candidate(
            CandidateStatus(candidate.status), CandidateAction.REJECT
        )
    except InvalidTransition as error:
        raise HTTPException(409, str(error)) from error
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="candidate.rejected",
            entity_type="candidate",
            entity_id=candidate.id,
        )
    )
    await session.flush()
    return candidate_view(candidate)


@router.get("/jobs", response_model=list[dict])
async def jobs(session: Session, auth: Auth):
    query = select(JobRecord)
    for key, value in auth.scope.model_dump().items():
        if value is not None or key == "personal_owner_id":
            query = query.where(JobRecord.scope[key].as_string() == value)
    records = (await session.scalars(query.order_by(JobRecord.created_at.desc()).limit(100))).all()
    return [
        {
            "id": r.id,
            "kind": r.kind,
            "state": r.state,
            "attempts": r.attempts,
            "error_code": r.error_code,
        }
        for r in records
    ]


@router.post("/jobs/{job_id}/retry")
async def retry_job(job_id: str, session: Session, auth: Auth) -> dict:
    require_reviewer(auth)
    visible = await jobs(session, auth)
    if job_id not in {j["id"] for j in visible}:
        raise HTTPException(404, "job not found")
    job = await session.get(JobRecord, job_id)
    if job.state in {"failed", "waiting_configuration"}:
        job.state = "pending"
        job.attempts = 0
    return {"state": job.state}


class SessionView(ContractModel):
    actor_id: str
    role: ActorRole
    scope: Scope


@router.get("/session", response_model=SessionView)
async def session_info(auth: Auth):
    return {"actor_id": auth.actor_id, "role": auth.role, "scope": auth.scope.model_dump()}
