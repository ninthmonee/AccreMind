import pytest
from accremind_contracts import CandidateStatus, ExperienceMaturity, ExperienceStatus, Scope
from accremind_experience_domain import (
    CandidateAction,
    DomainRuleViolation,
    ExperienceAction,
    InvalidTransition,
    ScopeViolation,
    constrain_scope,
    promote_maturity,
    transition_candidate,
    transition_experience,
)


def test_candidate_can_only_publish_after_processing_and_review() -> None:
    status = transition_candidate(CandidateStatus.SUBMITTED, CandidateAction.START_PROCESSING)
    status = transition_candidate(status, CandidateAction.MARK_READY)
    status = transition_candidate(status, CandidateAction.PUBLISH)
    assert status == CandidateStatus.PUBLISHED


def test_submitted_candidate_cannot_publish_directly() -> None:
    with pytest.raises(InvalidTransition):
        transition_candidate(CandidateStatus.SUBMITTED, CandidateAction.PUBLISH)


def test_published_experience_can_be_paused_and_republished() -> None:
    status = transition_experience(ExperienceStatus.PUBLISHED, ExperienceAction.PAUSE)
    assert transition_experience(status, ExperienceAction.REPUBLISH) == ExperienceStatus.PUBLISHED


def test_deprecated_experience_is_terminal() -> None:
    with pytest.raises(InvalidTransition):
        transition_experience(ExperienceStatus.DEPRECATED, ExperienceAction.REPUBLISH)


def test_team_token_may_narrow_to_project_in_same_team() -> None:
    authenticated = Scope(organization_id="org", team_id="frontend")
    requested = Scope(organization_id="org", team_id="frontend", project_id="studio")
    assert constrain_scope(authenticated, requested) == requested


def test_project_token_cannot_widen_to_team() -> None:
    authenticated = Scope(organization_id="org", team_id="frontend", project_id="studio")
    requested = Scope(organization_id="org", team_id="frontend")
    with pytest.raises(ScopeViolation):
        constrain_scope(authenticated, requested)


def test_cross_organization_scope_is_rejected() -> None:
    with pytest.raises(ScopeViolation):
        constrain_scope(Scope(organization_id="org-a"), Scope(organization_id="org-b"))


def test_maturity_requires_validation_then_independent_use() -> None:
    verified = promote_maturity(
        ExperienceMaturity.DRAFT,
        has_validation=True,
        independent_helpful_uses=0,
    )
    assert verified == ExperienceMaturity.VERIFIED
    assert (
        promote_maturity(
            verified,
            has_validation=True,
            independent_helpful_uses=2,
        )
        == ExperienceMaturity.PROVEN
    )


def test_maturity_cannot_skip_evidence() -> None:
    with pytest.raises(DomainRuleViolation):
        promote_maturity(
            ExperienceMaturity.DRAFT,
            has_validation=False,
            independent_helpful_uses=10,
        )
