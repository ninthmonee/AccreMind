import json
from datetime import date
from pathlib import Path

import pytest
from accremind_contracts import (
    Applicability,
    CandidateDraft,
    ExperienceFeedbackRequest,
    ExperienceSubmitRequest,
    ExperienceValidation,
    FeedbackKind,
    RecallBudget,
    RecallRequest,
    Scope,
    StaticExperienceDocument,
    TaskCompleteRequest,
)
from accremind_contracts.task import TaskOutcome
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[3]


def candidate() -> CandidateDraft:
    return CandidateDraft(
        title="React request race condition",
        problem="An older request overwrites a newer response.",
        context="A controlled filter changes rapidly.",
        solution="Cancel the older request or guard commits with a sequence number.",
        failed_attempts=["Only canceling when the component unmounts."],
        validation=ExperienceValidation(
            method="Resolve three deliberately reordered requests.",
            result="Only the final request is rendered.",
            verified_on=date(2026, 9, 9),
        ),
        applicability=Applicability(
            domains=["frontend"],
            technologies=["React", "TypeScript"],
            triggers=["request race"],
        ),
    )


def test_submit_requires_redaction_confirmation() -> None:
    with pytest.raises(ValidationError, match="redaction_confirmed must be true"):
        ExperienceSubmitRequest(
            task_id="task-1",
            candidate=candidate(),
            redaction_confirmed=False,
            idempotency_key="submit-1",
        )


def test_contracts_reject_unknown_fields() -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        RecallBudget(max_items=6, max_tokens=2400, unexpected=True)


def test_project_scope_requires_team() -> None:
    with pytest.raises(ValidationError, match="project scope requires team_id"):
        Scope(organization_id="org", project_id="project")


def test_task_candidates_require_verified_outcome() -> None:
    with pytest.raises(ValidationError, match="unverified tasks"):
        TaskCompleteRequest(
            task_id="task-1",
            outcome=TaskOutcome(summary="Implemented but not tested", verified=False),
            candidates=[candidate()],
            redaction_confirmed=True,
            idempotency_key="complete-1",
        )


def test_task_feedback_must_match_task() -> None:
    feedback = ExperienceFeedbackRequest(
        task_id="another-task",
        retrieval_id="ret-1",
        experience_id="EXP-FE-1",
        experience_version=1,
        kind=FeedbackKind.HELPFUL,
        idempotency_key="feedback-1",
    )
    with pytest.raises(ValidationError, match="all feedback"):
        TaskCompleteRequest(
            task_id="task-1",
            outcome=TaskOutcome(summary="Verified", verified=True),
            feedback=[feedback],
            redaction_confirmed=True,
            idempotency_key="complete-1",
        )


def test_static_document_uses_stable_file_id_and_sha256() -> None:
    document = StaticExperienceDocument(
        file_id="frontend-react-race",
        owner_id="user-1",
        scope=Scope(organization_id="org", team_id="frontend"),
        experience=candidate(),
        content_hash="a" * 64,
    )
    assert document.experience_id is None

    with pytest.raises(ValidationError):
        document.model_copy(update={"content_hash": "not-a-sha256"}).model_validate(
            {**document.model_dump(), "content_hash": "not-a-sha256"}
        )


def test_recall_budget_is_bounded() -> None:
    with pytest.raises(ValidationError):
        RecallRequest(
            task_id="task-1",
            query="React race",
            budget=RecallBudget(max_items=21),
        )


def test_checked_in_submit_example_matches_contract() -> None:
    payload = json.loads((ROOT / "schemas/examples/experience-submit.valid.json").read_text())
    parsed = ExperienceSubmitRequest.model_validate(payload)
    assert parsed.task_id == "client-task-123"


def test_checked_in_recall_example_matches_contract() -> None:
    payload = json.loads((ROOT / "schemas/examples/recall-request.valid.json").read_text())
    parsed = RecallRequest.model_validate(payload)
    assert parsed.requested_scope is not None
    assert parsed.requested_scope.project_id == "commerce-web"
