from enum import StrEnum

from accremind_contracts import CandidateStatus, ExperienceStatus

from .errors import InvalidTransition


class CandidateAction(StrEnum):
    START_PROCESSING = "start_processing"
    MARK_READY = "mark_ready"
    REJECT = "reject"
    MERGE = "merge"
    PUBLISH = "publish"


class ExperienceAction(StrEnum):
    PAUSE = "pause"
    REPUBLISH = "republish"
    DEPRECATE = "deprecate"


_CANDIDATE_TRANSITIONS = {
    (CandidateStatus.SUBMITTED, CandidateAction.START_PROCESSING): CandidateStatus.PROCESSING,
    (CandidateStatus.PROCESSING, CandidateAction.MARK_READY): CandidateStatus.READY_FOR_REVIEW,
    (CandidateStatus.PROCESSING, CandidateAction.REJECT): CandidateStatus.REJECTED,
    (CandidateStatus.READY_FOR_REVIEW, CandidateAction.REJECT): CandidateStatus.REJECTED,
    (CandidateStatus.READY_FOR_REVIEW, CandidateAction.MERGE): CandidateStatus.MERGED,
    (CandidateStatus.READY_FOR_REVIEW, CandidateAction.PUBLISH): CandidateStatus.PUBLISHED,
}

_EXPERIENCE_TRANSITIONS = {
    (ExperienceStatus.PUBLISHED, ExperienceAction.PAUSE): ExperienceStatus.PAUSED,
    (ExperienceStatus.PUBLISHED, ExperienceAction.DEPRECATE): ExperienceStatus.DEPRECATED,
    (ExperienceStatus.PAUSED, ExperienceAction.REPUBLISH): ExperienceStatus.PUBLISHED,
    (ExperienceStatus.PAUSED, ExperienceAction.DEPRECATE): ExperienceStatus.DEPRECATED,
}


def transition_candidate(status: CandidateStatus, action: CandidateAction) -> CandidateStatus:
    try:
        return _CANDIDATE_TRANSITIONS[(status, action)]
    except KeyError as error:
        raise InvalidTransition(f"cannot {action} candidate in {status} state") from error


def transition_experience(status: ExperienceStatus, action: ExperienceAction) -> ExperienceStatus:
    try:
        return _EXPERIENCE_TRANSITIONS[(status, action)]
    except KeyError as error:
        raise InvalidTransition(f"cannot {action} experience in {status} state") from error
