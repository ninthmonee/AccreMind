from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..api_models import ExperienceView
from ..application import load_experience
from ..auth import AuthContext, get_auth_context
from ..database import get_session

router = APIRouter(prefix="/api/v1/experiences", tags=["experiences"])
Session = Annotated[AsyncSession, Depends(get_session)]
Auth = Annotated[AuthContext, Depends(get_auth_context)]


@router.get(
    "/{experience_id}",
    response_model=ExperienceView,
    summary="获取已发布经验详情",
    description=(
        "按稳定 Experience ID 返回当前不可变版本。越出调用者 scope 的资源统一返回 404，"
        "避免泄露资源是否存在。"
    ),
    response_description="经验聚合信息与当前版本正文。",
)
async def get_experience(experience_id: str, session: Session, auth: Auth) -> ExperienceView:
    """读取调用者权限范围内的一条经验。"""

    return await load_experience(session, experience_id, auth)
