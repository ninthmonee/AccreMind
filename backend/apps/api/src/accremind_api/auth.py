import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated

from accremind_contracts import Scope
from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .database import get_session
from .models import TokenRecord
from .settings import get_settings


class ActorRole(StrEnum):
    DEVELOPER = "developer"
    REVIEWER = "reviewer"
    ADMIN = "admin"


@dataclass(frozen=True)
class AuthContext:
    actor_id: str
    role: ActorRole
    scope: Scope


async def get_auth_context(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    authorization: Annotated[str | None, Header()] = None,
    organization_id: Annotated[str | None, Header(alias="X-Organization-Id")] = None,
    actor_id: Annotated[str | None, Header(alias="X-Actor-Id")] = None,
    actor_role: Annotated[ActorRole, Header(alias="X-Actor-Role")] = ActorRole.DEVELOPER,
    team_id: Annotated[str | None, Header(alias="X-Team-Id")] = None,
    project_id: Annotated[str | None, Header(alias="X-Project-Id")] = None,
    personal_owner_id: Annotated[str | None, Header(alias="X-Personal-Owner-Id")] = None,
) -> AuthContext:
    if authorization is not None:
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Bearer token required")
        token_hash = hashlib.sha256(authorization[7:].encode()).hexdigest()
        token = await session.scalar(
            select(TokenRecord).where(TokenRecord.token_hash == token_hash)
        )
        if (
            token is None
            or token.revoked
            or token.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC)
        ):
            raise HTTPException(401, "invalid or expired token")
        auth = AuthContext(
            token.actor_id,
            ActorRole(token.role),
            Scope(
                organization_id=token.organization_id,
                team_id=token.team_id,
                project_id=token.project_id,
                personal_owner_id=token.personal_owner_id,
            ),
        )
        permission = endpoint_permission(request.url.path, request.method)
        if permission not in token.tools and "studio" not in token.tools:
            raise HTTPException(403, "token does not allow this operation")
        return auth
    if get_settings().environment == "production" or not organization_id or not actor_id:
        raise HTTPException(401, "Bearer token required")
    try:
        scope = Scope(
            organization_id=organization_id,
            team_id=team_id,
            project_id=project_id,
            personal_owner_id=personal_owner_id,
        )
    except ValueError as error:
        raise HTTPException(400, "invalid scope") from error
    return AuthContext(actor_id=actor_id, role=actor_role, scope=scope)


def endpoint_permission(path: str, method: str) -> str:
    if path.endswith("/retrieval/recall"):
        return "experience_recall"
    if path.endswith("/tasks/complete"):
        return "task_complete"
    if path.endswith("/feedback"):
        return "experience_feedback"
    if path.endswith("/candidates") and method == "POST":
        return "experience_submit"
    if "/experiences/" in path and method == "GET":
        return "experience_get"
    return "studio"


def require_reviewer(auth: AuthContext) -> None:
    """限制治理操作只能由审核者或管理员执行。"""

    if auth.role not in {ActorRole.REVIEWER, ActorRole.ADMIN}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="reviewer or admin role required",
        )
