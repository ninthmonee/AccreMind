from datetime import UTC, date, datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utc_now() -> datetime:
    return datetime.now(UTC)


class ScopeColumns:
    """在业务表中复用的多租户作用域列。"""

    organization_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    team_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    project_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    personal_owner_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)


class CandidateRecord(ScopeColumns, Base):
    """待审核候选经验；payload 保存已通过契约验证的草稿快照。"""

    __tablename__ = "candidates"
    __table_args__ = (
        UniqueConstraint(
            "organization_id", "actor_id", "idempotency_key", name="uq_candidate_idempotency"
        ),
        Index("ix_candidates_scope_status", "organization_id", "team_id", "project_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    actor_id: Mapped[str] = mapped_column(String(128), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    duplicate_suggestions: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    static_document: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    markdown_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_experience_id: Mapped[str | None] = mapped_column(
        ForeignKey("experiences.id"), nullable=True
    )
    base_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    used_experience_ids: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    published_experience_id: Mapped[str | None] = mapped_column(
        ForeignKey("experiences.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class ExperienceRecord(ScopeColumns, Base):
    """经验聚合根，只保存状态与当前版本指针。"""

    __tablename__ = "experiences"
    __table_args__ = (
        Index(
            "ix_experiences_searchable_scope",
            "organization_id",
            "team_id",
            "project_id",
            "status",
        ),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    current_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    owner_id: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )
    versions: Mapped[list["ExperienceVersionRecord"]] = relationship(
        back_populates="experience", cascade="all, delete-orphan"
    )


class ExperienceVersionRecord(Base):
    """不可变经验版本；正文快照与来源、成熟度信息一同保存。"""

    __tablename__ = "experience_versions"
    __table_args__ = (UniqueConstraint("experience_id", "version", name="uq_experience_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    experience_id: Mapped[str] = mapped_column(
        ForeignKey("experiences.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    source_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    maturity: Mapped[str] = mapped_column(String(32), nullable=False)
    freshness: Mapped[str] = mapped_column(String(32), nullable=False)
    search_vector: Mapped[str | None] = mapped_column(
        Text().with_variant(TSVECTOR(), "postgresql"), nullable=True
    )
    markdown_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    valid_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    created_by: Mapped[str] = mapped_column(String(128), nullable=False)
    experience: Mapped[ExperienceRecord] = relationship(back_populates="versions")


class AuditEventRecord(Base):
    """关键状态变更的追加式审计事件。"""

    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_entity", "entity_type", "entity_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    actor_id: Mapped[str] = mapped_column(String(128), nullable=False)
    action: Mapped[str] = mapped_column(String(128), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(128), nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class StaticFileRecord(Base):
    """One latest import per exact scope/file identity; source remains on Candidate."""

    __tablename__ = "static_files"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)


class ImportReceiptRecord(Base):
    """Commit replay scoped to authenticated actor and exact permission boundary."""

    __tablename__ = "import_receipts"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)


class EmbeddingRecord(Base):
    __tablename__ = "embeddings"
    __table_args__ = (UniqueConstraint("version_id", "index_version", name="uq_embedding_index"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version_id: Mapped[int] = mapped_column(ForeignKey("experience_versions.id"), nullable=False)
    index_version: Mapped[str] = mapped_column(String(128), nullable=False)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    vector: Mapped[list[float]] = mapped_column(
        Vector(1536).with_variant(JSON(), "sqlite"), nullable=False
    )


class RetrievalRecord(ScopeColumns, Base):
    __tablename__ = "retrieval_runs"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(128), nullable=False)
    task_id: Mapped[str] = mapped_column(String(128), nullable=False)
    mode: Mapped[str] = mapped_column(String(64), nullable=False)
    index_version: Mapped[str] = mapped_column(String(128), nullable=False)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class TokenRecord(ScopeColumns, Base):
    __tablename__ = "tokens"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    actor_id: Mapped[str] = mapped_column(String(128), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    tools: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked: Mapped[bool] = mapped_column(default=False)


class OperationRecord(ScopeColumns, Base):
    __tablename__ = "operations"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    id: Mapped[str] = mapped_column(String(128), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(128), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class FeedbackRecord(ScopeColumns, Base):
    __tablename__ = "feedback"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(128), nullable=False)
    task_id: Mapped[str] = mapped_column(String(128), nullable=False)
    retrieval_id: Mapped[str] = mapped_column(ForeignKey("retrieval_runs.id"), nullable=False)
    experience_id: Mapped[str] = mapped_column(ForeignKey("experiences.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class JobRecord(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(128), nullable=False)
    scope: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    state: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class EvaluationRunRecord(ScopeColumns, Base):
    """离线评测的聚合指标；不作为经验正文，也不参与召回。"""

    __tablename__ = "evaluation_runs"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    dataset: Mapped[str] = mapped_column(String(128), nullable=False)
    dataset_kind: Mapped[str] = mapped_column(String(64), nullable=False)
    query_count: Mapped[int] = mapped_column(Integer, nullable=False)
    recall_at_k: Mapped[float] = mapped_column(Float, nullable=False)
    mrr_at_k: Mapped[float] = mapped_column(Float, nullable=False)
    results: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
