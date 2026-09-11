import asyncio

import httpx
from accremind_mcp_gateway.server import create_server
from mcp import Client
from test_experience_loop import DEVELOPER_HEADERS, REVIEWER_HEADERS, recall_payload, submit_payload


def token(client, tools):
    response = client.post(
        "/api/v1/tokens", headers=DEVELOPER_HEADERS, json={"name": "test", "tools": tools}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_pat_permissions_revoke_and_no_header_override(client):
    created = token(client, ["experience_recall"])
    bearer = {"Authorization": "Bearer " + created["token"]}
    assert (
        client.post(
            "/api/v1/candidates", headers={**REVIEWER_HEADERS, **bearer}, json=submit_payload()
        ).status_code
        == 403
    )
    assert (
        client.post("/api/v1/retrieval/recall", headers=bearer, json=recall_payload()).status_code
        == 200
    )
    listed = client.get("/api/v1/tokens", headers=DEVELOPER_HEADERS)
    assert created["token"] not in listed.text
    assert "token_hash" not in listed.text
    assert (
        client.delete("/api/v1/tokens/" + created["id"], headers=DEVELOPER_HEADERS).status_code
        == 204
    )
    assert (
        client.post("/api/v1/retrieval/recall", headers=bearer, json=recall_payload()).status_code
        == 401
    )


def test_task_complete_is_atomic_and_candidate_only(client):
    request = {
        "task_id": "complete-task",
        "outcome": {"summary": "Validated", "verified": True},
        "candidates": [submit_payload()["candidate"]],
        "feedback": [],
        "redaction_confirmed": True,
        "idempotency_key": "done-1",
    }
    first = client.post("/api/v1/tasks/complete", headers=DEVELOPER_HEADERS, json=request)
    assert first.status_code == 200, first.text
    assert (
        client.post("/api/v1/tasks/complete", headers=DEVELOPER_HEADERS, json=request).json()
        == first.json()
    )
    candidate = client.get(
        "/api/v1/candidates/" + first.json()["candidate_ids"][0], headers=DEVELOPER_HEADERS
    ).json()
    assert candidate["status"] == "submitted"
    request["outcome"]["verified"] = False
    assert (
        client.post("/api/v1/tasks/complete", headers=DEVELOPER_HEADERS, json=request).status_code
        == 422
    )


def test_official_mcp_in_memory_contract(client):
    created = token(
        client,
        [
            "experience_recall",
            "experience_get",
            "experience_submit",
            "experience_feedback",
            "task_complete",
        ],
    )
    server = create_server(token=created["token"], transport=httpx.ASGITransport(app=client.app))

    async def exercise():
        async with Client(server) as sdk:
            tools = await sdk.list_tools()
            assert {t.name for t in tools.tools} == {
                "experience_recall",
                "experience_get",
                "experience_submit",
                "experience_feedback",
                "task_complete",
            }
            prompts = await sdk.list_prompts()
            assert prompts.prompts[0].name == "task-experience-loop"
            result = await sdk.call_tool("experience_submit", {"request": submit_payload()})
            assert not result.is_error, result
            assert result.structured_content["review_status"] == "submitted"
            recalled = await sdk.call_tool("experience_recall", {"request": recall_payload()})
            assert not recalled.is_error, recalled
            assert recalled.structured_content["items"] == []

    asyncio.run(exercise())
