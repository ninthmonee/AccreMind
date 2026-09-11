from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from ..static_import import commit_import, export_experience, preview_import
from ..static_models import (
    ImportCommitRequest,
    ImportCommitResult,
    ImportPreview,
    ImportPreviewRequest,
)
from .candidates import Auth, Session

router = APIRouter(prefix="/api/v1/static-import", tags=["static_import"])


@router.post("/preview", response_model=ImportPreview, summary="静态经验导入预检（不写入）")
async def preview(request: ImportPreviewRequest, session: Session, auth: Auth) -> ImportPreview:
    result, _ = await preview_import(session, request, auth)
    return result


@router.post("/commit", response_model=ImportCommitResult, summary="确认预检并原子创建待审核候选")
async def commit(request: ImportCommitRequest, session: Session, auth: Auth) -> ImportCommitResult:
    return await commit_import(session, request, auth)


@router.get(
    "/export/{experience_id}", response_class=PlainTextResponse, summary="导出当前经验为 Markdown"
)
async def export(experience_id: str, session: Session, auth: Auth) -> PlainTextResponse:
    return PlainTextResponse(
        await export_experience(session, experience_id, auth), media_type="text/markdown"
    )
