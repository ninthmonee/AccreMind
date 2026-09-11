from datetime import datetime

from accremind_contracts import (
    CandidateDraft,
    CandidateStatus,
    ExperienceStatus,
    ExperienceVersion,
    Scope,
    StaticExperienceDocument,
)
from accremind_contracts.common import ContractModel
from pydantic import Field


class CandidateView(ContractModel):
    """候选经验的完整 API 视图。"""

    candidate_id: str = Field(description="候选经验标识。")
    task_id: str = Field(description="产生候选经验的任务标识。")
    status: CandidateStatus = Field(description="候选经验当前审核状态。")
    candidate: CandidateDraft = Field(description="候选经验正文。")
    scope: Scope = Field(description="候选经验可见范围。")
    duplicate_suggestions: list[str] = Field(default_factory=list)
    static_document: StaticExperienceDocument | None = Field(
        default=None, description="静态来源与导入元数据。"
    )
    markdown_body: str | None = Field(
        default=None, description="需要一并审核的补充 Markdown 正文。"
    )
    submitted_by: str = Field(description="提交者标识。")
    published_experience_id: str | None = Field(default=None, description="发布后生成的经验标识。")
    created_at: datetime = Field(description="提交时间。")
    updated_at: datetime = Field(description="最后更新时间。")


class ExperienceView(ContractModel):
    """已发布经验及其当前版本的 API 视图。"""

    experience_id: str = Field(description="经验标识。")
    status: ExperienceStatus = Field(description="经验发布状态。")
    scope: Scope = Field(description="经验可见范围。")
    owner_id: str = Field(description="经验所有者标识。")
    current: ExperienceVersion = Field(description="当前生效版本。")
