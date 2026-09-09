import re
from datetime import UTC
from uuid import uuid4

from accremind_contracts import (
    CandidateDraft,
    CandidateStatus,
    ExperienceFreshness,
    ExperienceMaturity,
    ExperiencePack,
    ExperiencePackItem,
    ExperienceStatus,
    ExperienceSubmitRequest,
    ExperienceVersion,
    RecallRequest,
    Scope,
    SourceType,
)
from accremind_contracts.common import ExperienceSource
from accremind_experience_domain import (
    CandidateAction,
    InvalidTransition,
    ScopeViolation,
    constrain_scope,
    transition_candidate,
)
from fastapi import HTTPException, status
from sqlalchemy import Select, and_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .api_models import CandidateView, ExperienceView
from .auth import AuthContext, require_reviewer
from .models import (
    AuditEventRecord,
    CandidateRecord,
    ExperienceRecord,
    ExperienceVersionRecord,
)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:20].upper()}"


async def apply_database_scope(session: AsyncSession, auth: AuthContext) -> None:
    """设置事务级作用域变量，供 PostgreSQL 行级安全策略读取。"""

    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return
    values = {
        "organization_id": auth.scope.organization_id,
        "team_id": auth.scope.team_id or "",
        "project_id": auth.scope.project_id or "",
        "personal_owner_id": auth.scope.personal_owner_id or "",
    }
    for key, value in values.items():
        await session.execute(
            text("SELECT set_config(:setting, :value, true)"),
            {"setting": f"app.{key}", "value": value},
        )


def record_scope(record: CandidateRecord | ExperienceRecord) -> Scope:
    return Scope(
        organization_id=record.organization_id,
        team_id=record.team_id,
        project_id=record.project_id,
        personal_owner_id=record.personal_owner_id,
    )


def assert_can_access(auth: AuthContext, resource_scope: Scope) -> None:
    """校验资源范围；越权时统一返回 404，避免泄露资源是否存在。"""

    try:
        constrain_scope(auth.scope, resource_scope)
    except ScopeViolation as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="resource not found"
        ) from error


def candidate_view(record: CandidateRecord) -> CandidateView:
    return CandidateView(
        candidate_id=record.id,
        task_id=record.task_id,
        status=CandidateStatus(record.status),
        candidate=CandidateDraft.model_validate(record.payload),
        scope=record_scope(record),
        submitted_by=record.actor_id,
        published_experience_id=record.published_experience_id,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def experience_version(record: ExperienceVersionRecord) -> ExperienceVersion:
    payload = CandidateDraft.model_validate(record.payload)
    return ExperienceVersion(
        experience_id=record.experience_id,
        version=record.version,
        title=payload.title,
        problem=payload.problem,
        context=payload.context,
        solution=payload.solution,
        failed_attempts=payload.failed_attempts,
        validation=payload.validation,
        applicability=payload.applicability,
        source=ExperienceSource(
            type=SourceType(record.source_type),
            task_ref=record.source_ref if record.source_type == SourceType.MCP_TASK else None,
            file_id=record.source_ref if record.source_type == SourceType.STATIC_FILE else None,
        ),
        maturity=ExperienceMaturity(record.maturity),
        freshness=ExperienceFreshness(record.freshness),
        valid_until=record.valid_until,
        created_at=record.created_at.replace(tzinfo=record.created_at.tzinfo or UTC),
        created_by=record.created_by,
    )


def experience_view(
    experience: ExperienceRecord, version: ExperienceVersionRecord
) -> ExperienceView:
    return ExperienceView(
        experience_id=experience.id,
        status=ExperienceStatus(experience.status),
        scope=record_scope(experience),
        owner_id=experience.owner_id,
        current=experience_version(version),
    )


async def submit_candidate(
    session: AsyncSession, request: ExperienceSubmitRequest, auth: AuthContext
) -> CandidateView:
    """提交候选经验，并在相同调用者与幂等键下返回同一结果。"""

    await apply_database_scope(session, auth)
    existing = await session.scalar(
        select(CandidateRecord).where(
            CandidateRecord.organization_id == auth.scope.organization_id,
            CandidateRecord.actor_id == auth.actor_id,
            CandidateRecord.idempotency_key == request.idempotency_key,
        )
    )
    if existing is not None:
        return candidate_view(existing)

    record = CandidateRecord(
        id=new_id("CAN"),
        task_id=request.task_id,
        actor_id=auth.actor_id,
        idempotency_key=request.idempotency_key,
        status=CandidateStatus.SUBMITTED,
        payload=request.candidate.model_dump(mode="json"),
        used_experience_ids=request.used_experience_ids,
        organization_id=auth.scope.organization_id,
        team_id=auth.scope.team_id,
        project_id=auth.scope.project_id,
        personal_owner_id=auth.scope.personal_owner_id,
    )
    session.add(record)
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="candidate.submitted",
            entity_type="candidate",
            entity_id=record.id,
            metadata_json={"task_id": request.task_id},
        )
    )
    await session.flush()
    return candidate_view(record)


async def load_candidate(
    session: AsyncSession, candidate_id: str, auth: AuthContext
) -> CandidateRecord:
    """在数据库 RLS 与领域范围双重约束下读取候选经验。"""

    await apply_database_scope(session, auth)
    record = await session.get(CandidateRecord, candidate_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="candidate not found")
    assert_can_access(auth, record_scope(record))
    return record


async def prepare_candidate(
    session: AsyncSession, candidate_id: str, auth: AuthContext
) -> CandidateView:
    """由审核者将候选经验推进至待审核状态。"""

    require_reviewer(auth)
    record = await load_candidate(session, candidate_id, auth)
    current = CandidateStatus(record.status)
    if current == CandidateStatus.READY_FOR_REVIEW:
        return candidate_view(record)
    try:
        current = transition_candidate(current, CandidateAction.START_PROCESSING)
        current = transition_candidate(current, CandidateAction.MARK_READY)
    except InvalidTransition as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    record.status = current
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="candidate.ready_for_review",
            entity_type="candidate",
            entity_id=record.id,
        )
    )
    await session.flush()
    return candidate_view(record)


async def publish_candidate(
    session: AsyncSession, candidate_id: str, auth: AuthContext
) -> ExperienceView:
    """发布候选经验，并创建不可变的第一个经验版本。"""

    require_reviewer(auth)
    candidate = await load_candidate(session, candidate_id, auth)
    if candidate.published_experience_id is not None:
        return await load_experience(session, candidate.published_experience_id, auth)
    try:
        candidate.status = transition_candidate(
            CandidateStatus(candidate.status), CandidateAction.PUBLISH
        )
    except InvalidTransition as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    experience = ExperienceRecord(
        id=new_id("EXP"),
        status=ExperienceStatus.PUBLISHED,
        current_version=1,
        owner_id=candidate.actor_id,
        organization_id=candidate.organization_id,
        team_id=candidate.team_id,
        project_id=candidate.project_id,
        personal_owner_id=candidate.personal_owner_id,
    )
    version = ExperienceVersionRecord(
        experience_id=experience.id,
        version=1,
        payload=candidate.payload,
        source_type=SourceType.MCP_TASK,
        source_ref=candidate.task_id,
        maturity=ExperienceMaturity.VERIFIED,
        freshness=ExperienceFreshness.CURRENT,
        created_by=auth.actor_id,
    )
    session.add_all([experience, version])
    # 先持久化外键目标再关联 Candidate；这里没有 ORM relationship，若不显式
    # flush，SQLAlchemy 可能先执行 Candidate UPDATE，导致外键约束失败。
    await session.flush()
    candidate.published_experience_id = experience.id
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="experience.published",
            entity_type="experience",
            entity_id=experience.id,
            metadata_json={"candidate_id": candidate.id, "version": 1},
        )
    )
    await session.flush()
    return experience_view(experience, version)


async def load_experience(
    session: AsyncSession, experience_id: str, auth: AuthContext
) -> ExperienceView:
    """读取经验聚合及其当前生效版本。"""

    await apply_database_scope(session, auth)
    experience = await session.get(ExperienceRecord, experience_id)
    if experience is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="experience not found")
    assert_can_access(auth, record_scope(experience))
    version = await session.scalar(
        select(ExperienceVersionRecord).where(
            ExperienceVersionRecord.experience_id == experience.id,
            ExperienceVersionRecord.version == experience.current_version,
        )
    )
    if version is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="missing version"
        )
    return experience_view(experience, version)


def scoped_experience_query(
    scope: Scope,
) -> Select[tuple[ExperienceRecord, ExperienceVersionRecord]]:
    """构造严格受组织、团队、项目或个人范围约束的经验查询。"""

    conditions = [
        ExperienceRecord.organization_id == scope.organization_id,
        ExperienceRecord.status == ExperienceStatus.PUBLISHED,
        ExperienceRecord.personal_owner_id.is_(None),
    ]
    if scope.team_id is not None:
        conditions.append(ExperienceRecord.team_id == scope.team_id)
    if scope.project_id is not None:
        conditions.append(ExperienceRecord.project_id == scope.project_id)
    if scope.personal_owner_id is not None:
        conditions[-1] = ExperienceRecord.personal_owner_id == scope.personal_owner_id
        conditions.append(ExperienceRecord.team_id.is_(None))
        conditions.append(ExperienceRecord.project_id.is_(None))
    return (
        select(ExperienceRecord, ExperienceVersionRecord)
        .join(
            ExperienceVersionRecord,
            and_(
                ExperienceVersionRecord.experience_id == ExperienceRecord.id,
                ExperienceVersionRecord.version == ExperienceRecord.current_version,
            ),
        )
        .where(*conditions)
    )


def lexical_terms(text: str) -> set[str]:
    """为中英文文本生成轻量词项；中文同时生成连续二元词片段。"""

    lowered = text.lower()
    terms = set(re.findall(r"[a-z0-9_.-]{2,}", lowered))
    for sequence in re.findall(r"[\u4e00-\u9fff]+", lowered):
        terms.add(sequence)
        terms.update(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return terms


def lexical_score(query: str, candidate: CandidateDraft) -> float:
    """计算当前 MVP 使用的可解释词法相关度分数。"""

    query_terms = lexical_terms(query)
    if not query_terms:
        return 0
    searchable = " ".join(
        [
            candidate.title,
            candidate.problem,
            candidate.context,
            candidate.solution,
            *candidate.applicability.technologies,
            *candidate.applicability.triggers,
        ]
    ).lower()
    if query.lower() in searchable:
        return 1.0
    matches = sum(term in searchable for term in query_terms)
    return min(1.0, matches / max(1, min(len(query_terms), 6)))


async def recall(
    session: AsyncSession, request: RecallRequest, auth: AuthContext
) -> ExperiencePack:
    """在调用者允许的范围和预算内召回已发布经验。"""

    await apply_database_scope(session, auth)
    try:
        scope = constrain_scope(auth.scope, request.requested_scope)
    except ScopeViolation as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error

    rows = (await session.execute(scoped_experience_query(scope))).all()
    ranked: list[tuple[float, ExperienceRecord, ExperienceVersionRecord, CandidateDraft]] = []
    for experience, version in rows:
        payload = CandidateDraft.model_validate(version.payload)
        score = lexical_score(request.query, payload)
        if score > 0:
            ranked.append((score, experience, version, payload))
    ranked.sort(key=lambda item: (item[0], item[2].created_at), reverse=True)

    items: list[ExperiencePackItem] = []
    token_count = 0
    for score, experience, version, payload in ranked[: request.budget.max_items]:
        estimated_tokens = max(1, len(payload.solution) // 3)
        if token_count + estimated_tokens > request.budget.max_tokens:
            continue
        token_count += estimated_tokens
        items.append(
            ExperiencePackItem(
                experience_id=experience.id,
                version=version.version,
                title=payload.title,
                applicability=payload.applicability,
                guidance=payload.solution,
                source_summary=f"{version.source_type}:{version.source_ref or 'unknown'}",
                maturity=ExperienceMaturity(version.maturity),
                freshness=ExperienceFreshness(version.freshness),
                relevance_score=score,
            )
        )

    return ExperiencePack(
        retrieval_id=new_id("RET"),
        items=items,
        conflicts=[],
        gaps=[] if items else ["no_matching_published_experience"],
        token_count=token_count,
    )
