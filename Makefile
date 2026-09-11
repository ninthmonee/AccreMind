.PHONY: api check db-down db-up eval install lint mcp migrate schemas smoke smoke-static test worker

install:
	uv sync --all-packages --dev

db-up:
	docker compose -f deploy/compose/compose.yaml up -d postgres redis

db-down:
	docker compose -f deploy/compose/compose.yaml down

migrate:
	uv run alembic -c backend/apps/api/alembic.ini upgrade head

smoke:
	uv run python tools/smoke_api.py

smoke-static:
	uv run python tools/smoke_static_import.py

api:
	uv run uvicorn accremind_api.main:app --reload

worker:
	uv run celery -A accremind_worker.tasks.app worker --beat --loglevel=info

mcp:
	uv run accremind-mcp --transport stdio

eval:
	uv run celery -A accremind_worker.tasks.app call accremind.evaluation

schemas:
	uv run python tools/export_schemas.py
	uv run python tools/export_openapi.py

test:
	uv run pytest

lint:
	uv run ruff check .
	uv run ruff format --check .

check: schemas lint test
	git diff --exit-code -- schemas/
