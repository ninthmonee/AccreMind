from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_session

router = APIRouter(tags=["health"])
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get(
    "/health",
    summary="检查服务存活状态",
    description="只检查 FastAPI 进程是否能够响应，不访问数据库。",
    response_description="服务进程状态。",
)
async def health() -> dict[str, str]:
    """供容器和负载均衡器执行轻量存活检查。"""

    return {"status": "ok"}


@router.get(
    "/ready",
    summary="检查服务就绪状态",
    description="执行一次 `SELECT 1`，确认 Core API 能连接当前数据库。",
    response_description="服务与数据库均可用时返回 ready。",
)
async def ready(session: Session) -> dict[str, str]:
    """确认服务依赖已经就绪；数据库不可用时返回 5xx。"""

    await session.execute(text("SELECT 1"))
    return {"status": "ready"}
