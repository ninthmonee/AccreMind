"""Transactional preview/commit; uploaded filenames are labels, never disk paths."""

import hashlib
import json
from dataclasses import replace

from accremind_contracts import (
    CandidateDraft,
    CandidateStatus,
    ExperienceSubmitRequest,
    StaticExperienceDocument,
)
from accremind_experience_domain import ScopeViolation, constrain_scope
from accremind_static_experience.markdown import (
    StaticFileError,
    parse_markdown,
    render_markdown,
    scan_sensitive,
)
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .application import (
    apply_database_scope,
    load_candidate,
    load_experience,
    new_id,
    submit_candidate,
)
from .auth import AuthContext
from .models import AuditEventRecord, ExperienceVersionRecord, ImportReceiptRecord, StaticFileRecord
from .static_models import (
    ImportCommitRequest,
    ImportCommitResult,
    ImportDiagnostic,
    ImportPreview,
    ImportPreviewItem,
    ImportPreviewRequest,
)


def digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def file_key(document: StaticExperienceDocument) -> str:
    return digest([document.scope.model_dump(mode="json"), document.file_id])


async def lock_keys(session: AsyncSession, keys: list[str]) -> None:
    if session.get_bind().dialect.name == "postgresql":
        for key in sorted(set(keys)):
            await session.execute(
                text("SELECT pg_advisory_xact_lock(:key)"), {"key": int(key[:15], 16)}
            )


async def preview_import(
    session: AsyncSession, request: ImportPreviewRequest, auth: AuthContext
) -> tuple[ImportPreview, list[tuple[StaticExperienceDocument, str] | None]]:
    await apply_database_scope(session, auth)
    if sum(len(file.content.encode()) for file in request.files) > 2_000_000:
        raise HTTPException(413, "batch exceeds 2000000 bytes")
    items = []
    parsed: list[tuple[StaticExperienceDocument, str] | None] = []
    seen = set()
    for file in request.files:
        item = ImportPreviewItem(filename=file.filename, action="error")
        items.append(item)
        parsed.append(None)
        issues = scan_sensitive(file.content)
        if issues:
            item.diagnostics = [
                ImportDiagnostic(field=i.field, message=i.message, line=i.line) for i in issues
            ]
            continue
        try:
            document, body = parse_markdown(file.content)
            constrain_scope(auth.scope, document.scope)
        except StaticFileError as error:
            item.diagnostics = [
                ImportDiagnostic(field=error.field, message=error.message, line=error.line)
            ]
            continue
        except ValidationError as error:
            # Never echo rejected field values (which may contain sensitive data).
            item.diagnostics = [
                ImportDiagnostic(field=".".join(map(str, e["loc"])), message=e["type"])
                for e in error.errors()
            ]
            continue
        except ScopeViolation:
            item.diagnostics = [
                ImportDiagnostic(field="scope", message="scope outside caller permissions")
            ]
            continue
        item.file_id = document.file_id
        item.content_hash = document.content_hash
        key = file_key(document)
        if key in seen:
            item.action = "conflict"
            item.diagnostics = [
                ImportDiagnostic(field="file_id", message="duplicate file identity in batch")
            ]
            continue
        seen.add(key)
        parsed[-1] = (document, body)
        binding = await session.get(StaticFileRecord, key, populate_existing=True)
        item.action = "create"
        if binding is None:
            if document.experience_id is not None:
                item.action = "conflict"
                item.diagnostics = [
                    ImportDiagnostic(
                        field="experience_id", message="no matching static file binding"
                    )
                ]
            continue
        previous = await load_candidate(session, binding.candidate_id, auth)
        item.candidate_id = previous.id
        item.experience_id = previous.published_experience_id
        if document.experience_id not in {
            None,
            previous.published_experience_id,
        } or previous.status in {CandidateStatus.REJECTED, CandidateStatus.MERGED}:
            item.action = "conflict"
        elif binding.content_hash == document.content_hash:
            item.action = "unchanged"
        elif (
            previous.status != CandidateStatus.PUBLISHED
            or document.experience_id != previous.published_experience_id
        ):
            item.action = "conflict"
        else:
            experience = await load_experience(session, previous.published_experience_id, auth)
            if (
                experience.scope != document.scope
                or experience.owner_id != document.owner_id
                or experience.status != "published"
                or document.base_version != experience.current.version
            ):
                item.action = "conflict"
            else:
                item.action = "update"
                item.base_version = experience.current.version
        if item.action == "conflict":
            item.diagnostics = [
                ImportDiagnostic(
                    field="file_id",
                    message=(
                        "pending import or mismatched experience/owner; "
                        "export current published version before editing"
                    ),
                )
            ]
    preview = ImportPreview(
        preview_hash=digest(
            [auth.actor_id, auth.scope.model_dump(), [i.model_dump() for i in items]]
        ),
        items=items,
        can_commit=all(i.action not in {"error", "conflict"} for i in items),
    )
    return preview, parsed


async def commit_import(
    session: AsyncSession, request: ImportCommitRequest, auth: AuthContext
) -> ImportCommitResult:
    await apply_database_scope(session, auth)
    receipt_key = digest([auth.scope.model_dump(), auth.actor_id, request.idempotency_key])
    request_hash = digest(request.model_dump())
    await lock_keys(session, [receipt_key])
    receipt = await session.get(ImportReceiptRecord, receipt_key)
    if receipt:
        await load_candidate(session, receipt.candidate_id, auth)
        if receipt.request_hash != request_hash:
            raise HTTPException(409, "idempotency key already used for another request")
        return ImportCommitResult.model_validate(receipt.result)
    _, parsed = await preview_import(session, request, auth)
    await lock_keys(session, [file_key(item[0]) for item in parsed if item is not None])
    preview, parsed = await preview_import(session, request, auth)
    if not preview.can_commit or preview.preview_hash != request.preview_hash:
        raise HTTPException(409, "preview is invalid or stale; preview files again")
    candidate_ids = []
    unchanged_count = 0
    for item, data in zip(preview.items, parsed, strict=True):
        if item.action == "unchanged":
            candidate_ids.append(item.candidate_id)
            unchanged_count += 1
            continue
        assert data is not None
        document, body = data
        scoped_auth = replace(auth, scope=document.scope)
        submitted = await submit_candidate(
            session,
            ExperienceSubmitRequest(
                task_id="static-import",
                candidate=document.experience,
                redaction_confirmed=True,
                idempotency_key="static:" + digest([receipt_key, file_key(document)]),
            ),
            scoped_auth,
        )
        candidate = await load_candidate(session, submitted.candidate_id, scoped_auth)
        candidate.static_document = document.model_dump(mode="json")
        candidate.markdown_body = body
        candidate.target_experience_id = item.experience_id if item.action == "update" else None
        candidate.base_version = item.base_version
        binding = await session.get(StaticFileRecord, file_key(document))
        if binding is None:
            binding = StaticFileRecord(key=file_key(document))
            session.add(binding)
        binding.candidate_id = candidate.id
        binding.content_hash = document.content_hash
        candidate_ids.append(candidate.id)
        await session.flush()
    await apply_database_scope(session, auth)
    result = ImportCommitResult(candidate_ids=candidate_ids, unchanged_count=unchanged_count)
    session.add(
        ImportReceiptRecord(
            key=receipt_key,
            candidate_id=candidate_ids[0],
            request_hash=request_hash,
            result=result.model_dump(),
        )
    )
    session.add(
        AuditEventRecord(
            id=new_id("AUD"),
            organization_id=auth.scope.organization_id,
            actor_id=auth.actor_id,
            action="static_import.committed",
            entity_type="import",
            entity_id=receipt_key,
            metadata_json={"candidate_ids": candidate_ids, "unchanged_count": unchanged_count},
        )
    )
    await session.flush()
    return result


async def export_experience(session: AsyncSession, experience_id: str, auth: AuthContext) -> str:
    view = await load_experience(session, experience_id, auth)

    version = await session.scalar(
        select(ExperienceVersionRecord).where(
            ExperienceVersionRecord.experience_id == experience_id,
            ExperienceVersionRecord.version == view.current.version,
        )
    )
    assert version is not None

    document = StaticExperienceDocument(
        file_id=view.current.source.file_id or f"export-{experience_id}",
        experience_id=experience_id,
        base_version=view.current.version,
        owner_id=view.owner_id,
        scope=view.scope,
        valid_until=view.current.valid_until,
        experience=CandidateDraft.model_validate(version.payload),
        content_hash="0" * 64,
    )
    return render_markdown(document, version.markdown_body or "")
