import json
import os
from pathlib import Path

import httpx
import typer
from accremind_contracts import TaskCompleteRequest

app = typer.Typer(no_args_is_help=True)


def call(path: str, payload):
    token = os.environ.get("ACCREMIND_TOKEN")
    if not token:
        raise typer.BadParameter("set ACCREMIND_TOKEN")
    with httpx.Client(
        base_url=os.environ.get("ACCREMIND_API_URL", "http://127.0.0.1:8000"), timeout=30
    ) as client:
        response = client.post(path, json=payload, headers={"Authorization": "Bearer " + token})
    if response.is_error:
        typer.echo(f"Core API rejected request ({response.status_code})", err=True)
        raise typer.Exit(1)
    return response.json()


@app.command("import")
def import_files(
    directory: Path, confirm: bool = False, preview_hash: str = "", idempotency_key: str = ""
):
    """Preview explicitly selected Markdown directory; commit only with confirmation and hash."""
    if not directory.is_dir() or directory.is_symlink():
        raise typer.BadParameter("choose a real directory")
    paths = sorted(directory.glob("*.md"))
    if (
        not paths
        or len(paths) > 50
        or any(p.is_symlink() or p.stat().st_size > 128000 for p in paths)
    ):
        raise typer.BadParameter("choose 1–50 regular Markdown files, each <=128000 bytes")
    files = [{"filename": p.name, "content": p.read_text(encoding="utf-8")} for p in paths]
    body = {"files": files}
    endpoint = "/api/v1/static-import/preview"
    if confirm:
        if not preview_hash or not idempotency_key:
            raise typer.BadParameter("confirmation requires --preview-hash and --idempotency-key")
        endpoint = "/api/v1/static-import/commit"
        body.update(
            preview_hash=preview_hash, idempotency_key=idempotency_key, redaction_confirmed=True
        )
    typer.echo(json.dumps(call(endpoint, body), ensure_ascii=False, indent=2))


@app.command("complete")
def complete(payload: Path):
    """Submit an explicitly prepared, redacted task completion file."""
    if payload.is_symlink() or not payload.is_file() or payload.stat().st_size > 256000:
        raise typer.BadParameter("choose a regular task completion JSON file <=256000 bytes")
    request = TaskCompleteRequest.model_validate_json(payload.read_text())
    typer.echo(
        json.dumps(
            call("/api/v1/tasks/complete", request.model_dump(mode="json")), ensure_ascii=False
        )
    )
