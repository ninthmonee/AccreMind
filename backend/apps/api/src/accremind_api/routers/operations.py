from accremind_contracts import ExperienceFeedbackRequest, TaskCompleteRequest, TaskCompleteResult
from fastapi import APIRouter
from pydantic import BaseModel

from ..operations import complete, feedback
from .candidates import Auth, Session

router = APIRouter(prefix="/api/v1", tags=["tasks"])


class FeedbackResult(BaseModel):
    feedback_id: str
    accepted: bool


@router.post("/feedback", response_model=FeedbackResult)
async def submit_feedback(request: ExperienceFeedbackRequest, session: Session, auth: Auth):
    return await feedback(session, request, auth)


@router.post("/tasks/complete", response_model=TaskCompleteResult)
async def task_complete(request: TaskCompleteRequest, session: Session, auth: Auth):
    return await complete(session, request, auth)
