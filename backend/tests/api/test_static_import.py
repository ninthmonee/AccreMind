import pytest
from accremind_contracts import Scope, StaticExperienceDocument
from accremind_static_experience import convert_compound_engineering_markdown
from accremind_static_experience.markdown import parse_markdown, render_markdown
from fastapi.testclient import TestClient
from test_experience_loop import (
    DEVELOPER_HEADERS,
    REVIEWER_HEADERS,
    ROOT,
    recall_payload,
    submit_payload,
)

PREFIX = "/api/v1/static-import"


def markdown(**updates: object) -> str:
    document = StaticExperienceDocument(
        file_id="request-race",
        owner_id="developer-1",
        scope=Scope(organization_id="acme", team_id="frontend", project_id="commerce-web"),
        experience=submit_payload()["candidate"],
        content_hash="0" * 64,
    ).model_copy(update=updates)
    return render_markdown(document, "Supplemental explanation.")


def preview(client: TestClient, content: str, headers=DEVELOPER_HEADERS):
    response = client.post(
        PREFIX + "/preview",
        json={"files": [{"filename": "experience.md", "content": content}]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def commit(client: TestClient, content: str, key="import-1", headers=DEVELOPER_HEADERS):
    result = preview(client, content, headers)
    request = {
        "files": [{"filename": "experience.md", "content": content}],
        "preview_hash": result["preview_hash"],
        "idempotency_key": key,
        "redaction_confirmed": True,
    }
    response = client.post(PREFIX + "/commit", json=request, headers=headers)
    assert response.status_code == 200, response.text
    return response.json(), request


def publish(client: TestClient, candidate_id: str):
    assert (
        client.post(
            f"/api/v1/candidates/{candidate_id}/prepare-review", headers=REVIEWER_HEADERS
        ).status_code
        == 200
    )
    response = client.post(f"/api/v1/candidates/{candidate_id}/publish", headers=REVIEWER_HEADERS)
    assert response.status_code == 200, response.text
    return response.json()


def recalled(client):
    return client.post(
        "/api/v1/retrieval/recall", json=recall_payload(), headers=DEVELOPER_HEADERS
    ).json()["items"]


def test_static_import_publish_update_and_round_trip(client):
    content = markdown()
    assert preview(client, content)["items"][0]["action"] == "create"
    assert recalled(client) == []
    result, request = commit(client, content)
    assert recalled(client) == []
    candidate = client.get(
        "/api/v1/candidates/" + result["candidate_ids"][0], headers=REVIEWER_HEADERS
    )
    assert candidate.status_code == 200
    assert candidate.json()["markdown_body"] == "Supplemental explanation."
    assert candidate.json()["static_document"]["file_id"] == "request-race"
    assert client.post(PREFIX + "/commit", json=request, headers=DEVELOPER_HEADERS).json() == result
    assert preview(client, content)["items"][0]["action"] == "unchanged"
    view = publish(client, result["candidate_ids"][0])
    assert view["current"]["source"] == {
        "type": "static_file",
        "task_ref": None,
        "file_id": "request-race",
    }
    assert recalled(client)[0]["version"] == 1
    exported = client.get(PREFIX + "/export/" + view["experience_id"], headers=DEVELOPER_HEADERS)
    document, body = parse_markdown(exported.text)
    assert body == "Supplemental explanation."
    assert document.experience == parse_markdown(content)[0].experience
    assert preview(client, exported.text)["items"][0]["action"] == "unchanged"
    document.experience.solution += " Also record request sequence."
    updated = render_markdown(document, body + " More detail.")
    assert preview(client, updated)["items"][0]["action"] == "update"
    result, _ = commit(client, updated, "import-2")
    assert recalled(client)[0]["version"] == 1
    updated_view = publish(client, result["candidate_ids"][0])
    assert updated_view["experience_id"] == view["experience_id"]
    assert updated_view["current"]["version"] == 2
    assert recalled(client)[0]["version"] == 2
    exported_again = client.get(
        PREFIX + "/export/" + view["experience_id"], headers=DEVELOPER_HEADERS
    )
    next_document, next_body = parse_markdown(exported_again.text)
    assert next_document.base_version == 2
    assert next_document.experience == document.experience
    assert next_body == body + " More detail."
    stale = render_markdown(document, "another edit from v1")
    assert preview(client, stale)["items"][0]["action"] == "conflict"


def test_changed_content_requires_new_preview_and_unique_idempotency_key(client):
    original = markdown()
    result = preview(client, original)
    request = {
        "files": [{"filename": "experience.md", "content": original + "changed"}],
        "preview_hash": result["preview_hash"],
        "idempotency_key": "key",
        "redaction_confirmed": True,
    }
    assert (
        client.post(PREFIX + "/commit", json=request, headers=DEVELOPER_HEADERS).status_code == 409
    )
    assert preview(client, original)["items"][0]["action"] == "create"
    _, valid = commit(client, original)
    valid["files"][0]["content"] += "changed"
    assert client.post(PREFIX + "/commit", json=valid, headers=DEVELOPER_HEADERS).status_code == 409
    assert preview(client, original + "changed")["items"][0]["action"] == "conflict"


@pytest.mark.parametrize(
    "content,field",
    [
        ("not markdown", "front_matter"),
        ("---\na: [\n---", "front_matter"),
        ("---\na: &a [1]\nb: *a\n---", "front_matter"),
        ("---\na: 1\na: 2\n---", "front_matter"),
        ("---\na: " + "[" * 25 + "1" + "]" * 25 + "\n---", "front_matter"),
        ("---\nfile_id: bad space\n---", "file_id"),
        ("text\x00", "file"),
    ],
)
def test_invalid_files_are_diagnostics(client, content, field):
    result = preview(client, content)
    assert not result["can_commit"]
    assert result["items"][0]["action"] == "error"
    assert field in [d["field"] for d in result["items"][0]["diagnostics"]]


def test_sensitive_diagnostics_never_echo_secret_and_atomic_batch(client):
    secret = "sk-" + "a" * 32
    files = [
        {"filename": "valid.md", "content": markdown()},
        {"filename": "bad.md", "content": markdown() + secret},
    ]
    result = client.post(PREFIX + "/preview", json={"files": files}, headers=DEVELOPER_HEADERS)
    assert secret not in result.text
    assert not result.json()["can_commit"]
    response = client.post(
        PREFIX + "/commit",
        json={
            "files": files,
            "preview_hash": result.json()["preview_hash"],
            "idempotency_key": "batch",
            "redaction_confirmed": True,
        },
        headers=DEVELOPER_HEADERS,
    )
    assert response.status_code == 409
    assert preview(client, markdown())["items"][0]["action"] == "create"


def test_scope_isolation_and_duplicates(client):
    content = markdown()
    other_headers = {**DEVELOPER_HEADERS, "X-Project-Id": "other"}
    assert not preview(client, content, other_headers)["can_commit"]
    files = [{"filename": str(i), "content": content} for i in range(2)]
    assert not client.post(
        PREFIX + "/preview", json={"files": files}, headers=DEVELOPER_HEADERS
    ).json()["can_commit"]
    result, _ = commit(client, content)
    published = publish(client, result["candidate_ids"][0])
    assert (
        client.get(
            PREFIX + "/export/" + published["experience_id"], headers=other_headers
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/candidates/{result['candidate_ids'][0]}/publish", headers=other_headers
        ).status_code
        == 403
    )


def test_expired_import_never_recalled(client):
    from datetime import date

    result, _ = commit(client, markdown(valid_until=date(2020, 1, 1)))
    publish(client, result["candidate_ids"][0])
    assert recalled(client) == []


def test_compound_engineering_case_can_use_standard_import(client):
    converted = convert_compound_engineering_markdown(
        (ROOT / "compound-engineering/references/experiences/api.md").read_text(),
        source_path="compound-engineering/references/experiences/api.md",
        owner_id="developer-1",
        scope=Scope(organization_id="acme", team_id="frontend", project_id="commerce-web"),
    )
    assert converted.documents
    content = render_markdown(converted.documents[0])
    result, _ = commit(client, content)
    published = publish(client, result["candidate_ids"][0])
    assert published["current"]["source"]["type"] == "static_file"
