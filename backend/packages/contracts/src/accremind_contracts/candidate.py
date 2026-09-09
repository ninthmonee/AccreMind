from enum import StrEnum
from typing import Annotated

from pydantic import Field, model_validator

from .common import (
    Applicability,
    ContractModel,
    ExperienceValidation,
    Identifier,
    NonEmptyText,
)


class CandidateStatus(StrEnum):
    SUBMITTED = "submitted"
    PROCESSING = "processing"
    READY_FOR_REVIEW = "ready_for_review"
    REJECTED = "rejected"
    MERGED = "merged"
    PUBLISHED = "published"


class CandidateDraft(ContractModel):
    """待审核的经验正文草稿。"""

    title: Annotated[str, Field(min_length=3, max_length=200, description="候选经验标题。")]
    problem: NonEmptyText = Field(description="要解决的问题。")
    context: NonEmptyText = Field(description="问题发生的背景与约束。")
    solution: NonEmptyText = Field(description="已验证的解决方案。")
    failed_attempts: list[NonEmptyText] = Field(
        default_factory=list, max_length=20, description="无效尝试及其失败原因。"
    )
    validation: ExperienceValidation = Field(description="解决方案的验证证据。")
    applicability: Applicability = Field(description="该经验的适用条件。")


class ExperienceSubmitRequest(ContractModel):
    """提交候选经验的请求。"""

    task_id: Identifier = Field(description="产生候选经验的任务标识。")
    candidate: CandidateDraft = Field(description="候选经验正文。")
    used_experience_ids: list[Identifier] = Field(
        default_factory=list, max_length=100, description="本任务曾使用的经验标识。"
    )
    redaction_confirmed: bool = Field(description="是否已确认敏感信息完成脱敏。")
    idempotency_key: Identifier = Field(description="客户端生成的幂等键。")

    @model_validator(mode="after")
    def require_redaction_confirmation(self) -> "ExperienceSubmitRequest":
        if not self.redaction_confirmed:
            raise ValueError("redaction_confirmed must be true")
        return self


class DuplicateSuggestion(ContractModel):
    """可能与候选内容重复的已有经验。"""

    experience_id: Identifier = Field(description="已有经验标识。")
    score: Annotated[float, Field(ge=0, le=1, description="重复度分数，范围为 0 到 1。")]


class ExperienceSubmitResult(ContractModel):
    """候选经验提交结果。"""

    candidate_id: Identifier = Field(description="新建或幂等命中的候选经验标识。")
    review_status: CandidateStatus = Field(description="候选经验当前审核状态。")
    duplicate_suggestions: list[DuplicateSuggestion] = Field(
        default_factory=list, description="可能重复的已有经验列表。"
    )
