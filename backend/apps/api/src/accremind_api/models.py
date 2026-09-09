from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
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
