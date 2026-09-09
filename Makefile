.PHONY: api db-down db-up install migrate schemas smoke test lint check

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

api:
	uv run uvicorn accremind_api.main:app --reload

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
