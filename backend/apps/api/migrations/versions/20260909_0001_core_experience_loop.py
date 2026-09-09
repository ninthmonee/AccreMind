"""Create the core candidate-to-experience loop.

Revision ID: 20260909_0001
Revises:
Create Date: 2026-09-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260909_0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SCOPE_CHECK = (
    "(project_id IS NULL OR team_id IS NOT NULL) AND "
    "(personal_owner_id IS NULL OR (team_id IS NULL AND project_id IS NULL))"
)


def scope_columns() -> list[sa.Column]:
    return [
        sa.Column("organization_id", sa.String(length=128), nullable=False),
        sa.Column("team_id", sa.String(length=128), nullable=True),
        sa.Column("project_id", sa.String(length=128), nullable=True),
        sa.Column("personal_owner_id", sa.String(length=128), nullable=True),
    ]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "experiences",
        sa.Column("id", sa.String(length=128), primary_key=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("current_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("owner_id", sa.String(length=128), nullable=False),
        *scope_columns(),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("current_version > 0", name="ck_experience_current_version"),
        sa.CheckConstraint(
            "status IN ('published', 'paused', 'deprecated')", name="ck_experience_status"
        ),
        sa.CheckConstraint(SCOPE_CHECK, name="ck_experience_scope_hierarchy"),
    )
    op.create_index("ix_experiences_organization_id", "experiences", ["organization_id"])
    op.create_index("ix_experiences_team_id", "experiences", ["team_id"])
    op.create_index("ix_experiences_project_id", "experiences", ["project_id"])
    op.create_index("ix_experiences_personal_owner_id", "experiences", ["personal_owner_id"])
    op.create_index("ix_experiences_status", "experiences", ["status"])
    op.create_index(
        "ix_experiences_searchable_scope",
        "experiences",
        ["organization_id", "team_id", "project_id", "status"],
    )

    op.create_table(
        "experience_versions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "experience_id",
            sa.String(length=128),
            sa.ForeignKey("experiences.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("source_ref", sa.String(length=128), nullable=True),
        sa.Column("maturity", sa.String(length=32), nullable=False),
        sa.Column("freshness", sa.String(length=32), nullable=False),
        sa.Column("valid_until", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=False),
        sa.CheckConstraint("version > 0", name="ck_experience_version_positive"),
        sa.CheckConstraint(
            "source_type IN ('mcp_task', 'static_file')", name="ck_experience_version_source"
        ),
        sa.CheckConstraint(
            "maturity IN ('draft', 'verified', 'proven')", name="ck_experience_version_maturity"
        ),
        sa.CheckConstraint(
            "freshness IN ('current', 'review_due', 'expired')",
            name="ck_experience_version_freshness",
        ),
        sa.UniqueConstraint("experience_id", "version", name="uq_experience_version"),
    )
    op.create_index(
        "ix_experience_versions_experience_id", "experience_versions", ["experience_id"]
    )

    op.create_table(
        "candidates",
        sa.Column("id", sa.String(length=128), primary_key=True),
        sa.Column("task_id", sa.String(length=128), nullable=False),
        sa.Column("actor_id", sa.String(length=128), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("used_experience_ids", sa.JSON(), nullable=False),
        sa.Column(
            "published_experience_id",
            sa.String(length=128),
            sa.ForeignKey("experiences.id", ondelete="SET NULL"),
            nullable=True,
        ),
        *scope_columns(),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('submitted', 'processing', 'ready_for_review', 'rejected', 'merged', "
            "'published')",
            name="ck_candidate_status",
        ),
        sa.CheckConstraint(SCOPE_CHECK, name="ck_candidate_scope_hierarchy"),
        sa.UniqueConstraint(
            "organization_id", "actor_id", "idempotency_key", name="uq_candidate_idempotency"
        ),
    )
    op.create_index("ix_candidates_organization_id", "candidates", ["organization_id"])
    op.create_index("ix_candidates_team_id", "candidates", ["team_id"])
    op.create_index("ix_candidates_project_id", "candidates", ["project_id"])
    op.create_index("ix_candidates_personal_owner_id", "candidates", ["personal_owner_id"])
    op.create_index("ix_candidates_task_id", "candidates", ["task_id"])
    op.create_index("ix_candidates_status", "candidates", ["status"])
    op.create_index(
        "ix_candidates_scope_status",
        "candidates",
        ["organization_id", "team_id", "project_id", "status"],
    )

    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(length=128), primary_key=True),
        sa.Column("organization_id", sa.String(length=128), nullable=False),
        sa.Column("actor_id", sa.String(length=128), nullable=False),
        sa.Column("action", sa.String(length=128), nullable=False),
        sa.Column("entity_type", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=128), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_audit_events_organization_id", "audit_events", ["organization_id"])
    op.create_index("ix_audit_entity", "audit_events", ["entity_type", "entity_id", "created_at"])

    if bind.dialect.name == "postgresql":
        create_rls_policies()


def create_rls_policies() -> None:
    scope_expression = """
        organization_id = current_setting('app.organization_id', true)
        AND (
            (
                current_setting('app.personal_owner_id', true) <> ''
                AND personal_owner_id = current_setting('app.personal_owner_id', true)
            )
            OR (
                current_setting('app.personal_owner_id', true) = ''
                AND personal_owner_id IS NULL
                AND (
                    current_setting('app.team_id', true) = ''
                    OR team_id = current_setting('app.team_id', true)
                )
                AND (
                    current_setting('app.project_id', true) = ''
                    OR project_id = current_setting('app.project_id', true)
                )
            )
        )
    """
    for table in ("candidates", "experiences"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY {table}_scope_policy ON {table} "
            f"USING ({scope_expression}) WITH CHECK ({scope_expression})"
        )
    op.execute("ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE audit_events FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY audit_events_org_policy ON audit_events "
        "USING (organization_id = current_setting('app.organization_id', true)) "
        "WITH CHECK (organization_id = current_setting('app.organization_id', true))"
    )
    op.execute("ALTER TABLE experience_versions ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE experience_versions FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY experience_versions_scope_policy ON experience_versions "
        "USING (EXISTS (SELECT 1 FROM experiences e WHERE e.id = experience_id)) "
        "WITH CHECK (EXISTS (SELECT 1 FROM experiences e WHERE e.id = experience_id))"
    )


def downgrade() -> None:
    op.drop_table("audit_events")
    op.drop_table("candidates")
    op.drop_table("experience_versions")
    op.drop_table("experiences")
