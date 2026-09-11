from typing import Literal

from accremind_contracts.common import ContractModel, Identifier
from pydantic import Field


class ImportFile(ContractModel):
    filename: str = Field(min_length=1, max_length=256)
    content: str = Field(min_length=1, max_length=128_000)


class ImportPreviewRequest(ContractModel):
    files: list[ImportFile] = Field(min_length=1, max_length=50)


class ImportDiagnostic(ContractModel):
    field: str
    message: str
    line: int | None = None


class ImportPreviewItem(ContractModel):
    filename: str
    file_id: str | None = None
    content_hash: str | None = None
    action: Literal["create", "update", "unchanged", "conflict", "error"]
    candidate_id: str | None = None
    experience_id: str | None = None
    base_version: int | None = None
    diagnostics: list[ImportDiagnostic] = Field(default_factory=list)


class ImportPreview(ContractModel):
    preview_hash: str
    items: list[ImportPreviewItem]
    can_commit: bool


class ImportCommitRequest(ImportPreviewRequest):
    preview_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    idempotency_key: Identifier
    redaction_confirmed: Literal[True]


class ImportCommitResult(ContractModel):
    candidate_ids: list[str]
    unchanged_count: int
