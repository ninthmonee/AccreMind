from enum import StrEnum

from pydantic import Field

from .common import ContractModel, Identifier, ShortText


class FeedbackKind(StrEnum):
    INJECTED = "injected"
    USED = "used"
    HELPFUL = "helpful"
    NOT_RELEVANT = "not_relevant"
    INCORRECT = "incorrect"
    OUTDATED = "outdated"
    CONFLICTING = "conflicting"


class ExperienceFeedbackRequest(ContractModel):
    task_id: Identifier
    retrieval_id: Identifier
    experience_id: Identifier
    experience_version: int = Field(ge=1)
    kind: FeedbackKind
    note: ShortText | None = None
    idempotency_key: Identifier
