import math

import httpx
from accremind_contracts import CandidateDraft, ExperiencePack, ExperiencePackItem, RecallRequest
from accremind_model_providers import EmbeddingProvider, OpenAICompatibleEmbedding
from accremind_retriever_agent import normalize_technology, rrf, terms
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import AuthContext
from .models import EmbeddingRecord, ExperienceVersionRecord, RetrievalRecord
from .settings import get_settings


def embedding_provider() -> EmbeddingProvider | None:
    settings = get_settings()
    if not settings.embedding_base_url:
        return None
    return OpenAICompatibleEmbedding(
        base_url=settings.embedding_base_url,
        api_key=settings.embedding_api_key.get_secret_value(),
        model=settings.embedding_model,
    )


def search_text(payload: dict) -> str:
    draft = CandidateDraft.model_validate(payload)
    return " ".join(
        terms(
            " ".join(
                [
                    draft.title,
                    draft.problem,
                    draft.context,
                    draft.solution,
                    *draft.applicability.technologies,
                    *draft.applicability.triggers,
                ]
            )
        )
    )


async def index_fts(session: AsyncSession, version: ExperienceVersionRecord) -> None:
    if session.get_bind().dialect.name == "postgresql":
        version.search_vector = func.to_tsvector("simple", search_text(version.payload))


async def embed_version(
    session: AsyncSession,
    version: ExperienceVersionRecord,
    provider: EmbeddingProvider | None = None,
) -> bool:
    settings = get_settings()
    provider = provider or embedding_provider()
    if provider is None:
        return False
    existing = await session.scalar(
        select(EmbeddingRecord).where(
            EmbeddingRecord.version_id == version.id,
            EmbeddingRecord.index_version == settings.embedding_index_version,
        )
    )
    if existing:
        if existing.model != settings.embedding_model:
            raise ValueError("index version cannot mix embedding models")
        return True
    draft = CandidateDraft.model_validate(version.payload)
    vector = (await provider.embed([draft.title + "\n" + draft.problem + "\n" + draft.solution]))[0]
    if len(vector) != 1536 or not all(math.isfinite(v) for v in vector) or not any(vector):
        raise ValueError("embedding must be nonzero, finite and 1536-dimensional")
    session.add(
        EmbeddingRecord(
            version_id=version.id,
            index_version=settings.embedding_index_version,
            model=settings.embedding_model,
            vector=vector,
        )
    )
    await session.flush()
    return True


async def retrieve(
    session: AsyncSession,
    request: RecallRequest,
    auth: AuthContext,
    provider: EmbeddingProvider | None = None,
) -> ExperiencePack:
    from accremind_experience_domain import ScopeViolation, constrain_scope
    from fastapi import HTTPException

    from .application import apply_database_scope, new_id, scoped_experience_query

    await apply_database_scope(session, auth)
    try:
        scope = constrain_scope(auth.scope, request.requested_scope)
    except ScopeViolation as error:
        raise HTTPException(403, str(error)) from error
    settings = get_settings()
    base = scoped_experience_query(scope)
    query_terms = terms(request.query + " " + (request.context.error or ""))
    postgres = session.get_bind().dialect.name == "postgresql"
    rows_by_id = {}
    rankings = []
    mode = "fts" if postgres else "lexical_test"
    gaps = []
    if query_terms:
        if postgres:
            # Tokens contain no tsquery syntax. OR allows sparse partial matches.
            query = func.to_tsquery("simple", " | ".join("'" + t + "'" for t in query_terms))
            score = func.ts_rank_cd(ExperienceVersionRecord.search_vector, query)
            rows = (
                await session.execute(
                    base.where(ExperienceVersionRecord.search_vector.op("@@")(query))
                    .order_by(score.desc(), ExperienceVersionRecord.id)
                    .limit(100)
                )
            ).all()
        else:
            from .application import lexical_score

            rows = (await session.execute(base)).all()
            rows = sorted(
                (
                    r
                    for r in rows
                    if lexical_score(request.query, CandidateDraft.model_validate(r[1].payload)) > 0
                ),
                key=lambda r: lexical_score(
                    request.query, CandidateDraft.model_validate(r[1].payload)
                ),
                reverse=True,
            )[:100]
        rows_by_id.update({e.id: (e, v) for e, v in rows})
        rankings.append([e.id for e, _ in rows])
    provider = provider or embedding_provider()
    if postgres and provider:
        try:
            vector = (await provider.embed([request.query]))[0]
            distance = EmbeddingRecord.vector.cosine_distance(vector)
            semantic = (
                await session.execute(
                    base.join(
                        EmbeddingRecord, EmbeddingRecord.version_id == ExperienceVersionRecord.id
                    )
                    .where(
                        EmbeddingRecord.index_version == settings.embedding_index_version,
                        EmbeddingRecord.model == settings.embedding_model,
                        distance <= 1 - settings.embedding_min_similarity,
                    )
                    .order_by(distance)
                    .limit(100)
                )
            ).all()
            rows_by_id.update({e.id: (e, v) for e, v in semantic})
            rankings.append([e.id for e, _ in semantic])
            mode = "hybrid"
        except (httpx.HTTPError, ValueError, KeyError):
            gaps.append("embedding_unavailable_fts_fallback")
    elif postgres:
        gaps.append("embedding_not_configured")
    scores = rrf(rankings)
    requested_tech = {normalize_technology(t) for t in request.context.technologies}
    candidates = []
    for identifier, score in scores.items():
        experience, version = rows_by_id[identifier]
        draft = CandidateDraft.model_validate(version.payload)
        applicable = draft.applicability
        if applicable.project_ids and scope.project_id not in applicable.project_ids:
            continue
        if (
            request.context.phase
            and applicable.phases
            and request.context.phase not in applicable.phases
        ):
            continue
        if (
            requested_tech
            and applicable.technologies
            and not requested_tech.intersection(
                normalize_technology(t) for t in applicable.technologies
            )
        ):
            continue
        trigger = any(t.lower() in request.query.lower() for t in applicable.triggers)
        candidates.append((score + (0.01 if trigger else 0), experience, version, draft))
    candidates.sort(key=lambda c: (-c[0], c[1].id))
    items = []
    token_count = 0
    for score, experience, version, draft in candidates:
        if len(items) >= request.budget.max_items:
            break
        cost = len(draft.solution.encode("utf-8"))  # conservative upper bound, multilingual
        if token_count + cost > request.budget.max_tokens:
            continue
        token_count += cost
        items.append(
            ExperiencePackItem(
                experience_id=experience.id,
                version=version.version,
                title=draft.title,
                applicability=draft.applicability,
                guidance=draft.solution,
                source_summary=f"{version.source_type}:{version.source_ref}",
                maturity=version.maturity,
                freshness=version.freshness,
                relevance_score=min(1, score * 20),
            )
        )
    if not items:
        gaps.append("no_matching_published_experience")
    result = ExperiencePack(
        retrieval_id=new_id("RET"), items=items, gaps=gaps, token_count=token_count
    )
    session.add(
        RetrievalRecord(
            id=result.retrieval_id,
            actor_id=auth.actor_id,
            task_id=request.task_id,
            mode=mode,
            index_version=settings.embedding_index_version,
            items=[
                {"experience_id": i.experience_id, "version": i.version, "score": i.relevance_score}
                for i in items
            ],
            **scope.model_dump(),
        )
    )
    await session.flush()
    return result
