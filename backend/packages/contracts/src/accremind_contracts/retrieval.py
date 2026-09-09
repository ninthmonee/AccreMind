from typing import Annotated

from pydantic import Field

from .common import Applicability, ContractModel, Identifier, NonEmptyText, Phase, Scope, ShortText
from .experience import ExperienceFreshness, ExperienceMaturity


class RecallBudget(ContractModel):
    """单次召回的数量与文本预算。"""

    max_items: int = Field(default=6, ge=0, le=20, description="最多返回的经验条数。")
    max_tokens: int = Field(
        default=2400, ge=0, le=12_000, description="经验指导文本的最大估算 Token 数。"
    )


class RecallContext(ContractModel):
    """辅助检索器理解当前任务的上下文。"""

    phase: Phase | None = Field(default=None, description="当前研发阶段。")
    technologies: list[ShortText] = Field(
        default_factory=list, max_length=50, description="当前任务使用的技术栈。"
    )
    error: NonEmptyText | None = Field(default=None, description="当前错误信息。")
    attempted: list[NonEmptyText] = Field(
        default_factory=list, max_length=20, description="已经尝试过的处理方式。"
    )


class RecallRequest(ContractModel):
    """按任务语义召回经验的请求。"""

    task_id: Identifier = Field(description="发起召回的任务标识。")
    query: Annotated[str, Field(min_length=2, max_length=4_000, description="召回查询文本。")]
    requested_scope: Scope | None = Field(
        default=None, description="请求查询的范围；必须受调用者范围约束。"
    )
    context: RecallContext = Field(default_factory=RecallContext, description="任务上下文。")
    budget: RecallBudget = Field(default_factory=RecallBudget, description="返回结果预算。")


class ExperiencePackItem(ContractModel):
    """可直接注入模型上下文的一条经验。"""

    experience_id: Identifier = Field(description="经验标识。")
    version: int = Field(ge=1, description="经验版本号。")
    title: ShortText = Field(description="经验标题。")
    applicability: Applicability = Field(description="适用条件。")
    guidance: NonEmptyText = Field(description="建议注入模型上下文的指导内容。")
    source_summary: ShortText = Field(description="经验来源摘要。")
    maturity: ExperienceMaturity = Field(description="经验成熟度。")
    freshness: ExperienceFreshness = Field(description="经验新鲜度。")
    relevance_score: Annotated[
        float, Field(ge=0, le=1, description="与当前查询的相关度，范围为 0 到 1。")
    ]


class ExperienceConflict(ContractModel):
    """召回结果中互相冲突的经验说明。"""

    experience_ids: list[Identifier] = Field(
        min_length=2, max_length=20, description="存在冲突的经验标识。"
    )
    explanation: NonEmptyText = Field(description="冲突原因及处理建议。")


class ExperiencePack(ContractModel):
    """单次召回生成的经验上下文包。"""

    retrieval_id: Identifier = Field(description="本次召回标识。")
    items: list[ExperiencePackItem] = Field(description="按相关度排序的经验列表。")
    conflicts: list[ExperienceConflict] = Field(
        default_factory=list, description="经验之间的冲突说明。"
    )
    gaps: list[ShortText] = Field(default_factory=list, description="未被经验覆盖的知识缺口。")
    token_count: int = Field(ge=0, description="返回内容的估算 Token 数。")
