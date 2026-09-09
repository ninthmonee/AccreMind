from pydantic import Field, model_validator

from .candidate import CandidateDraft
from .common import ContractModel, Identifier, ShortText
from .feedback import ExperienceFeedbackRequest


class TaskOutcome(ContractModel):
    summary: ShortText
    verified: bool


class TaskCompleteRequest(ContractModel):
    task_id: Identifier
    outcome: TaskOutcome
    feedback: list[ExperienceFeedbackRequest] = Field(default_factory=list, max_length=100)
    candidates: list[CandidateDraft] = Field(default_factory=list, max_length=20)
    redaction_confirmed: bool
    idempotency_key: Identifier

    @model_validator(mode="after")
    def validate_submission(self) -> "TaskCompleteRequest":
        if not self.redaction_confirmed:
            raise ValueError("redaction_confirmed must be true")
        for feedback in self.feedback:
            if feedback.task_id != self.task_id:
                raise ValueError("all feedback must refer to the completed task")
        if self.candidates and not self.outcome.verified:
            raise ValueError("unverified tasks cannot submit candidate experiences")
        return self


class TaskCompleteResult(ContractModel):
    completion_id: Identifier
    candidate_ids: list[Identifier] = Field(default_factory=list)
    feedback_accepted: int = Field(ge=0)
