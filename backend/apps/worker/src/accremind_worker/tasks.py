import asyncio
import json
import os
from datetime import date, timedelta
from pathlib import Path

from accremind_api.application import (
    apply_database_scope,
    load_candidate,
    new_id,
    prepare_candidate,
    publish_candidate,
    record_scope,
    scoped_experience_query,
    submit_candidate,
)
from accremind_api.auth import ActorRole, AuthContext
from accremind_api.database import SessionFactory, build_engine, engine
from accremind_api.models import (
    AuditEventRecord,
    EvaluationRunRecord,
    ExperienceRecord,
    ExperienceVersionRecord,
    FeedbackRecord,
    JobRecord,
)
from accremind_api.retriever import embed_version, retrieve
from accremind_api.settings import get_settings
from accremind_contracts import (
    CandidateDraft,
    CandidateStatus,
    ExperienceFreshness,
    ExperienceMaturity,
    ExperienceStatus,
    ExperienceSubmitRequest,
    RecallRequest,
    Scope,
)
from accremind_experience_domain import promote_maturity
from accremind_retriever_agent import metrics
from accremind_static_experience.markdown import scan_sensitive
from celery import Celery
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

# 错误或冲突反馈累计到该数量后暂停默认召回，等待人工复核。
REVIEW_PAUSE_THRESHOLD = 3
# proven 需要多次独立使用反馈，不能由提交者声明。
PROVEN_HELPFUL_THRESHOLD = 2
NEGATIVE_FEEDBACK_KINDS = ("incorrect", "conflicting", "outdated", "not_relevant")
# 评测语料落在独立租户，重复运行靠幂等键复用同一批经验。
EVALUATION_ORGANIZATION = "eval-synthetic"
EVALUATION_ACTOR = "evaluator"

app = Celery("accremind", broker=os.environ.get("ACCREMIND_REDIS_URL", "redis://127.0.0.1:6379/0"))
app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    task_ignore_result=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    beat_schedule={
        "durable-job-dispatch": {"task": "accremind.dispatch", "schedule": 10.0},
        "review-due-scan": {"task": "accremind.review_due", "schedule": 24 * 60 * 60.0},
        "feedback-aggregate": {"task": "accremind.feedback_aggregate", "schedule": 60 * 60.0},
    },
)

# 周期治理任务需要跨租户扫描，只能走 BYPASSRLS 维护角色；业务写入仍用 SessionFactory。
maintenance_engine = build_engine(get_settings().maintenance_database_url)
MaintenanceFactory = async_sessionmaker(maintenance_engine, expire_on_commit=False)


def current_version_join():
    return and_(
        ExperienceVersionRecord.experience_id == ExperienceRecord.id,
        ExperienceVersionRecord.version == ExperienceRecord.current_version,
    )


async def review_experience(session, experience_id: str, auth: AuthContext) -> None:
    """按负面反馈证据复核经验：达阈值暂停默认召回，否则标记为待复核。"""

    experience = await session.scalar(
        select(ExperienceRecord)
        .where(ExperienceRecord.id == experience_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if experience is None:
        raise ValueError("missing experience")
    counts = dict(
        (
            await session.execute(
                select(FeedbackRecord.kind, func.count())
                .where(
                    FeedbackRecord.experience_id == experience.id,
                    FeedbackRecord.organization_id == experience.organization_id,
                )
                .group_by(FeedbackRecord.kind)
            )
        ).all()
    )
    version = await session.scalar(
        select(ExperienceVersionRecord).where(
            ExperienceVersionRecord.experience_id == experience.id,
            ExperienceVersionRecord.version == experience.current_version,
        )
    )
    if version is None:
        raise ValueError("missing version")
    # incorrect/conflicting 指向内容本身有问题；outdated/not_relevant 只提示复核。
    blocking = counts.get("incorrect", 0) + counts.get("conflicting", 0)
    if blocking >= REVIEW_PAUSE_THRESHOLD:
        experience.status = ExperienceStatus.PAUSED
        action = "experience.paused"
    else:
        version.freshness = ExperienceFreshness.REVIEW_DUE
        action = "experience.review_due"
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=experience.organization_id,
            actor_id=auth.actor_id,
            action=action,
            entity_type="experience",
            entity_id=experience.id,
            metadata_json={"feedback_counts": {key: int(value) for key, value in counts.items()}},
        )
    )
    await session.flush()


async def flag_review_due() -> int:
    """跨租户把到期与临近到期的经验标入复核队列，不改变发布状态。"""

    window = timedelta(days=get_settings().review_due_window_days)
    horizon = date.today() + window
    async with MaintenanceFactory() as session, session.begin():
        rows = (
            await session.execute(
                select(ExperienceRecord, ExperienceVersionRecord)
                .join(ExperienceVersionRecord, current_version_join())
                .where(
                    ExperienceRecord.status == ExperienceStatus.PUBLISHED,
                    ExperienceVersionRecord.valid_until.is_not(None),
                    ExperienceVersionRecord.valid_until <= horizon,
                )
            )
        ).all()
        touched = 0
        for experience, version in rows:
            freshness = (
                ExperienceFreshness.EXPIRED
                if version.valid_until < date.today()
                else ExperienceFreshness.REVIEW_DUE
            )
            if version.freshness == freshness:
                continue
            version.freshness = freshness
            session.add(
                AuditEventRecord(
                    id=new_id("AUD"),
                    organization_id=experience.organization_id,
                    actor_id="worker",
                    action=f"experience.{freshness.value}",
                    entity_type="experience",
                    entity_id=experience.id,
                    metadata_json={"valid_until": version.valid_until.isoformat()},
                )
            )
            touched += 1
        return touched


async def promote_proven(session) -> int:
    """按不同使用者的 helpful 反馈把当前版本从 verified 提升为 proven。"""

    rows = (
        await session.execute(
            select(
                ExperienceRecord,
                ExperienceVersionRecord,
                func.count(func.distinct(FeedbackRecord.actor_id)),
            )
            .join(ExperienceVersionRecord, current_version_join())
            .join(
                FeedbackRecord,
                and_(
                    FeedbackRecord.experience_id == ExperienceRecord.id,
                    FeedbackRecord.version == ExperienceVersionRecord.version,
                    FeedbackRecord.kind == "helpful",
                ),
            )
            .where(ExperienceVersionRecord.maturity == ExperienceMaturity.VERIFIED)
            .group_by(ExperienceRecord.id, ExperienceVersionRecord.id)
        )
    ).all()
    promoted = 0
    for experience, version, helpful_actors in rows:
        if helpful_actors < PROVEN_HELPFUL_THRESHOLD:
            continue
        version.maturity = promote_maturity(
            ExperienceMaturity(version.maturity),
            has_validation=True,
            independent_helpful_uses=helpful_actors,
            proven_threshold=PROVEN_HELPFUL_THRESHOLD,
        )
        session.add(
            AuditEventRecord(
                id=new_id("AUD"),
                organization_id=experience.organization_id,
                actor_id="worker",
                action="experience.proven",
                entity_type="experience",
                entity_id=experience.id,
                metadata_json={"helpful_actors": int(helpful_actors)},
            )
        )
        promoted += 1
    return promoted


async def aggregate_feedback() -> int:
    """聚合使用反馈：提升成熟度，并把有负面证据的经验交给复核。"""

    async with MaintenanceFactory() as session, session.begin():
        promoted = await promote_proven(session)
        targets = list(
            (
                await session.scalars(
                    select(FeedbackRecord.experience_id)
                    .where(FeedbackRecord.kind.in_(NEGATIVE_FEEDBACK_KINDS))
                    .group_by(FeedbackRecord.experience_id)
                )
            ).all()
        )
    reviewed = 0
    if targets:
        async with MaintenanceFactory() as session, session.begin():
            for experience_id in targets:
                experience = await session.get(ExperienceRecord, experience_id)
                if experience is None or experience.status != ExperienceStatus.PUBLISHED:
                    continue
                auth = AuthContext("worker", ActorRole.REVIEWER, record_scope(experience))
                await review_experience(session, experience_id, auth)
                reviewed += 1
    return promoted + reviewed


async def run_evaluation() -> dict:
    """对版本化数据集跑离线召回评测，并把聚合指标写入 evaluation_runs。"""

    dataset_path = Path(get_settings().evaluation_dataset_path)
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    auth = AuthContext(
        EVALUATION_ACTOR,
        ActorRole.REVIEWER,
        Scope(organization_id=EVALUATION_ORGANIZATION),
    )
    identifiers: dict[str, str] = {}
    results: list[dict] = []
    async with SessionFactory() as session, session.begin():
        await apply_database_scope(session, auth)
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
                idempotency_key=case["id"],
            )
            candidate = await submit_candidate(session, request, auth)
            if candidate.status == CandidateStatus.SUBMITTED:
                await prepare_candidate(session, candidate.candidate_id, auth)
            experience = await publish_candidate(session, candidate.candidate_id, auth)
            identifiers[case["id"]] = experience.experience_id
        for case in dataset["cases"]:
            for query in case["queries"]:
                pack = await retrieve(
                    session, RecallRequest(task_id="evaluation", query=query), auth
                )
                expected = {identifiers[case["id"]]}
                results.append(
                    {
                        "case": case["id"],
                        "query": query,
                        **metrics(expected, [item.experience_id for item in pack.items]),
                    }
                )
        record = EvaluationRunRecord(
            id=new_id("EVAL"),
            dataset=dataset_path.name,
            dataset_kind=dataset["dataset_kind"],
            query_count=len(results),
            recall_at_k=sum(row["recall_at_k"] for row in results) / len(results),
            mrr_at_k=sum(row["reciprocal_rank"] for row in results) / len(results),
            results=results,
            **auth.scope.model_dump(),
        )
        session.add(record)
        await session.flush()
        return {
            "evaluation_id": record.id,
            "query_count": record.query_count,
            "recall_at_k": record.recall_at_k,
            "mrr_at_k": record.mrr_at_k,
        }


async def process_job(job_id: str):
    async with SessionFactory() as session, session.begin():
        job = await session.scalar(
            select(JobRecord).where(JobRecord.id == job_id).with_for_update(skip_locked=True)
        )
        if job is None or job.state not in {"pending", "waiting_configuration"}:
            return
        auth = AuthContext("worker", ActorRole.REVIEWER, Scope.model_validate(job.scope))
        await apply_database_scope(session, auth)
        try:
            async with session.begin_nested():
                if job.kind == "candidate.process":
                    candidate = await load_candidate(session, job.entity_id, auth, for_update=True)
                    if candidate.status not in {"submitted", "processing"}:
                        job.state = "done"
                        return
                    issues = scan_sensitive(
                        candidate.payload.__str__() + (candidate.markdown_body or "")
                    )
                    if issues:
                        candidate.status = "rejected"
                    else:
                        rows = (await session.execute(scoped_experience_query(auth.scope))).all()
                        candidate.duplicate_suggestions = [
                            e.id
                            for e, v in rows
                            if CandidateDraft.model_validate(v.payload).solution
                            == CandidateDraft.model_validate(candidate.payload).solution
                        ][:20]
                        await session.flush()
                        await prepare_candidate(session, candidate.id, auth)
                elif job.kind == "experience.embed":
                    version = await session.get(ExperienceVersionRecord, int(job.entity_id))
                    if version is None:
                        raise ValueError("missing version")
                    if not await embed_version(session, version):
                        job.state = "waiting_configuration"
                        return
                elif job.kind == "experience.review":
                    await review_experience(session, job.entity_id, auth)
                else:
                    raise ValueError("unknown job kind")
                job.state = "done"
                job.error_code = None
        except Exception as error:
            job.attempts += 1
            job.error_code = type(error).__name__
            job.state = "failed" if job.attempts >= 5 else "pending"


async def pending_ids():
    async with SessionFactory() as session:
        return list(
            (
                await session.scalars(
                    select(JobRecord.id)
                    .where(JobRecord.state == "pending")
                    .order_by(JobRecord.created_at)
                    .limit(100)
                )
            ).all()
        )


def run(coroutine):
    async def scoped():
        try:
            return await coroutine
        finally:
            await engine.dispose()
            await maintenance_engine.dispose()

    return asyncio.run(scoped())


@app.task(name="accremind.process")
def process(job_id):
    run(process_job(job_id))


@app.task(name="accremind.dispatch")
def dispatch():
    for job_id in run(pending_ids()):
        process.delay(job_id)


@app.task(name="accremind.review_due")
def review_due():
    run(flag_review_due())


@app.task(name="accremind.feedback_aggregate")
def feedback_aggregate():
    run(aggregate_feedback())


@app.task(name="accremind.evaluation")
def evaluation():
    run(run_evaluation())
