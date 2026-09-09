from datetime import date, datetime
from enum import StrEnum

from pydantic import Field

from .common import (
    Applicability,
    ContractModel,
    ExperienceSource,
    ExperienceValidation,
    Identifier,
    NonEmptyText,
    Scope,
    ShortText,
)


class ExperienceStatus(StrEnum):
    PUBLISHED = "published"
    PAUSED = "paused"
    DEPRECATED = "deprecated"


class ExperienceMaturity(StrEnum):
    DRAFT = "draft"
    VERIFIED = "verified"
    PROVEN = "proven"


class ExperienceFreshness(StrEnum):
    CURRENT = "current"
    REVIEW_DUE = "review_due"
    EXPIRED = "expired"


class ExperienceVersion(ContractModel):
    """不可变的经验版本快照。"""

    model_config = ContractModel.model_config | {"frozen": True}

    experience_id: Identifier = Field(description="所属经验标识。")
    version: int = Field(ge=1, description="从 1 开始递增的版本号。")
    title: ShortText = Field(description="经验标题。")
    problem: NonEmptyText = Field(description="要解决的问题。")
    context: NonEmptyText = Field(description="问题背景与约束。")
    solution: NonEmptyText = Field(description="已验证的解决方案。")
    failed_attempts: list[NonEmptyText] = Field(
        default_factory=list, max_length=20, description="无效尝试及失败原因。"
    )
    validation: ExperienceValidation = Field(description="验证证据。")
    applicability: Applicability = Field(description="适用条件。")
    source: ExperienceSource = Field(description="经验来源。")
    maturity: ExperienceMaturity = Field(description="经验成熟度。")
    freshness: ExperienceFreshness = Field(description="经验新鲜度。")
    valid_until: date | None = Field(default=None, description="经验有效截止日期。")
    created_at: datetime = Field(description="版本创建时间。")
    created_by: Identifier = Field(description="版本创建者标识。")


class Experience(ContractModel):
    """经验聚合根及其当前状态。"""

    id: Identifier = Field(description="经验标识。")
    scope: Scope = Field(description="经验可见范围。")
    status: ExperienceStatus = Field(description="经验发布状态。")
    current_version: int = Field(ge=1, description="当前生效版本号。")
    owner_id: Identifier = Field(description="经验所有者标识。")
    created_at: datetime = Field(description="经验创建时间。")
    updated_at: datetime = Field(description="经验最后更新时间。")
