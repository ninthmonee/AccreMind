from typing import Annotated

from accremind_contracts import ExperiencePack, RecallRequest
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..application import recall
from ..auth import AuthContext, get_auth_context
from ..database import get_session

router = APIRouter(prefix="/api/v1/retrieval", tags=["retrieval"])
Session = Annotated[AsyncSession, Depends(get_session)]
Auth = Annotated[AuthContext, Depends(get_auth_context)]


@router.post(
    "/recall",
    response_model=ExperiencePack,
    summary="召回相关经验",
    description=(
        "根据问题、技术栈、阶段和预算召回 Published Corpus。requested_scope 只能收窄"
        "身份请求头的权限；没有匹配时返回空 items 与明确 gaps，不生成虚构经验。"
    ),
    response_description="带稳定 ID、版本、适用范围和相关度的 Experience Pack。",
)
async def recall_experiences(
    request: RecallRequest,
    session: Session,
    auth: Auth,
) -> ExperiencePack:
    """在权限过滤和 token 预算内组装 Experience Pack。"""

    return await recall(session, request, auth)
