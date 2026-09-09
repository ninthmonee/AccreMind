from datetime import date

from pydantic import Field

from .candidate import CandidateDraft
from .common import ContractModel, Identifier, Scope


class StaticExperienceDocument(ContractModel):
    """Validated YAML front matter; Markdown body is handled separately."""

    file_id: Identifier
    experience_id: Identifier | None = None
    owner_id: Identifier
    scope: Scope
    valid_until: date | None = None
    experience: CandidateDraft
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
