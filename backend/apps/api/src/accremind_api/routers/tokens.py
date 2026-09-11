import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from accremind_contracts.common import ContractModel
from fastapi import APIRouter, HTTPException
from pydantic import Field
from sqlalchemy import select

from ..application import apply_database_scope, assert_can_access, new_id, record_scope
from ..models import AuditEventRecord, TokenRecord
from .candidates import Auth, Session

router = APIRouter(prefix="/api/v1/tokens", tags=["tokens"])
ToolName = Literal[
    "experience_recall",
    "experience_get",
    "experience_submit",
    "experience_feedback",
    "task_complete",
    "studio",
]


class TokenRequest(ContractModel):
    name: str = Field(min_length=1, max_length=128)
    days: int = Field(default=30, ge=1, le=365)
    tools: list[ToolName] = Field(min_length=1, max_length=6)


class TokenView(ContractModel):
    id: str
    name: str
    tools: list[str]
    expires_at: datetime
    revoked: bool


class TokenCreated(TokenView):
    token: str


def view(token):
    return TokenView(
        id=token.id,
        name=token.name,
        tools=token.tools,
        expires_at=token.expires_at,
        revoked=token.revoked,
    )


@router.post("", response_model=TokenCreated)
async def create_token(request: TokenRequest, session: Session, auth: Auth):
    raw = "acm_" + secrets.token_urlsafe(32)
    token = TokenRecord(
        id=new_id("PAT"),
        token_hash=hashlib.sha256(raw.encode()).hexdigest(),
        actor_id=auth.actor_id,
        role=auth.role,
        name=request.name,
        tools=request.tools,
        expires_at=datetime.now(UTC) + timedelta(days=request.days),
        revoked=False,
        **auth.scope.model_dump(),
    )
    session.add(token)
    await apply_database_scope(session, auth)
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="token.created",
            entity_type="token",
            entity_id=token.id,
        )
    )
    await session.flush()
    return TokenCreated(**view(token).model_dump(), token=raw)


@router.get("", response_model=list[TokenView])
async def list_tokens(session: Session, auth: Auth):
    query = select(TokenRecord).where(TokenRecord.actor_id == auth.actor_id)
    for key, value in auth.scope.model_dump().items():
        query = query.where(getattr(TokenRecord, key) == value)
    return [view(t) for t in (await session.scalars(query)).all()]


@router.delete("/{token_id}", status_code=204)
async def revoke_token(token_id: str, session: Session, auth: Auth):
    token = await session.get(TokenRecord, token_id)
    if token is None or token.actor_id != auth.actor_id:
        raise HTTPException(404, "token not found")
    assert_can_access(auth, record_scope(token))
    token.revoked = True
    await apply_database_scope(session, auth)
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="token.revoked",
            entity_type="token",
            entity_id=token.id,
        )
    )
