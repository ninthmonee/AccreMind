from typing import Annotated

from accremind_contracts import ExperienceSubmitRequest
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..api_models import CandidateView, ExperienceView
from ..application import prepare_candidate, publish_candidate, submit_candidate
from ..auth import AuthContext, get_auth_context
from ..database import get_session

router = APIRouter(prefix="/api/v1/candidates", tags=["candidates"])
Session = Annotated[AsyncSession, Depends(get_session)]
Auth = Annotated[AuthContext, Depends(get_auth_context)]


@router.post(
    "",
    response_model=CandidateView,
    status_code=status.HTTP_201_CREATED,
    summary="提交候选经验",
    description=(
        "由 Coding Agent 或受信客户端提交经过验证和脱敏确认的候选经验。"
        "接口只创建 Candidate，不会直接进入生产召回；同一调用者重复使用"
        "相同 idempotency_key 时返回原 Candidate。"
    ),
    response_description="新建或幂等命中的候选经验。",
)
async def submit(
    request: ExperienceSubmitRequest,
    session: Session,
    auth: Auth,
) -> CandidateView:
    """提交候选经验，权限范围完全取自开发态身份请求头。"""

    return await submit_candidate(session, request, auth)


@router.post(
    "/{candidate_id}/prepare-review",
    response_model=CandidateView,
    summary="将候选经验标记为待审核",
    description=(
        "仅 reviewer/admin 可调用。当前同步实现依次执行 submitted → processing → "
        "ready_for_review；后续接入 Worker 后仍保持相同外部状态契约。"
    ),
    response_description="进入 ready_for_review 状态的 Candidate。",
)
async def prepare(candidate_id: str, session: Session, auth: Auth) -> CandidateView:
    """执行候选预处理状态转换。"""

    return await prepare_candidate(session, candidate_id, auth)


@router.post(
    "/{candidate_id}/publish",
    response_model=ExperienceView,
    summary="审核并发布候选经验",
    description=(
        "仅 reviewer/admin 可调用，且 Candidate 必须处于 ready_for_review。发布操作在"
        "同一事务中创建 Experience 与不可变 Version 1；重复发布返回已创建的 Experience。"
    ),
    response_description="发布后的经验及当前版本。",
)
async def publish(candidate_id: str, session: Session, auth: Auth) -> ExperienceView:
    """把审核通过的 Candidate 发布为可召回 Experience。"""

    return await publish_candidate(session, candidate_id, auth)
