from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated

from accremind_contracts import Scope
from fastapi import Header, HTTPException, status


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
    organization_id: Annotated[
        str, Header(alias="X-Organization-Id", description="调用者所属组织 ID。")
    ],
    actor_id: Annotated[str, Header(alias="X-Actor-Id", description="当前调用者稳定 ID。")],
    actor_role: Annotated[
        ActorRole,
        Header(alias="X-Actor-Role", description="开发态角色：developer、reviewer 或 admin。"),
    ] = ActorRole.DEVELOPER,
    team_id: Annotated[
        str | None, Header(alias="X-Team-Id", description="可选的团队权限边界。")
    ] = None,
    project_id: Annotated[
        str | None, Header(alias="X-Project-Id", description="可选的项目权限边界。")
    ] = None,
    personal_owner_id: Annotated[
        str | None, Header(alias="X-Personal-Owner-Id", description="可选的个人权限边界。")
    ] = None,
) -> AuthContext:
    """将开发态身份请求头收敛为可信 AuthContext。

    请求体中的 scope 只能进一步收窄这里得到的权限，不能扩大权限。
    """

    try:
        scope = Scope(
            organization_id=organization_id,
            team_id=team_id,
            project_id=project_id,
            personal_owner_id=personal_owner_id,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    return AuthContext(actor_id=actor_id, role=actor_role, scope=scope)


def require_reviewer(auth: AuthContext) -> None:
    """限制治理操作只能由审核者或管理员执行。"""

    if auth.role not in {ActorRole.REVIEWER, ActorRole.ADMIN}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="reviewer or admin role required",
        )
