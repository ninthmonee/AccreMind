from datetime import date

from pydantic import Field

from .candidate import CandidateDraft
from .common import ContractModel, Identifier, Scope


class StaticExperienceDocument(ContractModel):
    """Validated YAML front matter; Markdown body is handled separately."""

    file_id: Identifier
    experience_id: Identifier | None = None
    base_version: int | None = Field(
        default=None, ge=1, description="导出时的版本，用于更新冲突检测。"
    )
    owner_id: Identifier
    scope: Scope
    valid_until: date | None = None
    experience: CandidateDraft
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
