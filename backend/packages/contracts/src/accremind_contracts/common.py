from datetime import date
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator

Identifier = Annotated[
    str,
    Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
        description="稳定标识符，仅允许字母、数字以及 . _ : -。",
    ),
]
NonEmptyText = Annotated[
    str, Field(min_length=1, max_length=10_000, description="不可为空的正文文本。")
]
ShortText = Annotated[str, Field(min_length=1, max_length=500, description="不可为空的短文本。")]


class ContractModel(BaseModel):
    """所有跨 AccreMind 系统边界数据的严格契约基类。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Phase(StrEnum):
    DESIGN = "design"
    IMPLEMENT = "implement"
    TROUBLESHOOT = "troubleshoot"
    REVIEW = "review"
    TEST = "test"
    DEPLOY = "deploy"


class SourceType(StrEnum):
    MCP_TASK = "mcp_task"
    STATIC_FILE = "static_file"


class Scope(ContractModel):
    """经验数据的组织、团队、项目或个人可见范围。"""

    organization_id: Identifier = Field(description="所属组织标识。")
    team_id: Identifier | None = Field(default=None, description="所属团队标识。")
    project_id: Identifier | None = Field(default=None, description="所属项目标识。")
    personal_owner_id: Identifier | None = Field(
        default=None, description="个人范围所有者标识；不可与团队或项目范围并用。"
    )

    @model_validator(mode="after")
    def validate_hierarchy(self) -> "Scope":
        if self.project_id is not None and self.team_id is None:
            raise ValueError("project scope requires team_id")
        if self.personal_owner_id is not None and (
            self.team_id is not None or self.project_id is not None
        ):
            raise ValueError("personal scope cannot be combined with team or project scope")
        return self


class Applicability(ContractModel):
    """经验适用条件，用于召回过滤与相关性判断。"""

    domains: list[ShortText] = Field(
        default_factory=list, max_length=20, description="适用业务或技术领域。"
    )
    technologies: list[ShortText] = Field(
        default_factory=list, max_length=50, description="适用技术栈。"
    )
    project_ids: list[Identifier] = Field(
        default_factory=list, max_length=50, description="明确适用的项目标识。"
    )
    phases: list[Phase] = Field(default_factory=list, max_length=10, description="适用的研发阶段。")
    triggers: list[ShortText] = Field(
        default_factory=list, max_length=50, description="触发召回的错误或场景关键词。"
    )


class ExperienceValidation(ContractModel):
    """经验结论的验证证据。"""

    method: NonEmptyText = Field(description="验证方式或执行步骤。")
    result: NonEmptyText = Field(description="验证结果与判定依据。")
    verified_on: date | None = Field(default=None, description="最近验证日期。")


class ExperienceSource(ContractModel):
    """经验来源；任务来源与静态文件来源互斥。"""

    type: SourceType = Field(description="来源类型。")
    task_ref: Identifier | None = Field(default=None, description="产生经验的任务标识。")
    file_id: Identifier | None = Field(default=None, description="静态经验文件标识。")

    @model_validator(mode="after")
    def validate_source_reference(self) -> "ExperienceSource":
        if self.type == SourceType.MCP_TASK and self.file_id is not None:
            raise ValueError("mcp_task source cannot contain file_id")
        if self.type == SourceType.STATIC_FILE and self.task_ref is not None:
            raise ValueError("static_file source cannot contain task_ref")
        return self
