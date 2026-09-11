"""Cross-tenant governance scans and offline evaluation run records."""

import sqlalchemy as sa
from alembic import op

revision = "20260910_0006"
down_revision = "20260910_0005"
branch_labels = None
depends_on = None

MAINTENANCE_ROLE = "accremind_maintenance"
MAINTENANCE_PASSWORD = "accremind_maintenance"

SCOPE_EXPRESSION = """organization_id = current_setting('app.organization_id', true)
    AND ((current_setting('app.personal_owner_id', true) <> ''
        AND personal_owner_id = current_setting('app.personal_owner_id', true))
      OR (current_setting('app.personal_owner_id', true) = '' AND personal_owner_id IS NULL
        AND (current_setting('app.team_id', true) = ''
          OR team_id = current_setting('app.team_id', true))
        AND (current_setting('app.project_id', true) = ''
          OR project_id = current_setting('app.project_id', true))))"""


def upgrade() -> None:
    op.create_table(
        "evaluation_runs",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("organization_id", sa.String(128), nullable=False),
        sa.Column("team_id", sa.String(128)),
        sa.Column("project_id", sa.String(128)),
        sa.Column("personal_owner_id", sa.String(128)),
        sa.Column("dataset", sa.String(128), nullable=False),
        sa.Column("dataset_kind", sa.String(64), nullable=False),
        sa.Column("query_count", sa.Integer(), nullable=False),
        sa.Column("recall_at_k", sa.Float(), nullable=False),
        sa.Column("mrr_at_k", sa.Float(), nullable=False),
        sa.Column("results", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    for name in ("organization_id", "team_id", "project_id", "personal_owner_id"):
        op.create_index("ix_evaluation_runs_" + name, "evaluation_runs", [name])
    op.execute("ALTER TABLE evaluation_runs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE evaluation_runs FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY evaluation_runs_scope_policy ON evaluation_runs "
        f"USING ({SCOPE_EXPRESSION}) WITH CHECK ({SCOPE_EXPRESSION})"
    )

    if op.get_bind().dialect.name == "postgresql":
        create_maintenance_role()


def create_maintenance_role() -> None:
    """周期治理任务要跨租户扫描，业务连接（accremind_app）仍受 RLS 约束。"""

    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT FROM pg_catalog.pg_roles WHERE rolname = '{MAINTENANCE_ROLE}'
            ) THEN
                CREATE ROLE {MAINTENANCE_ROLE} LOGIN PASSWORD '{MAINTENANCE_PASSWORD}'
                    NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
            END IF;
            EXECUTE format(
                'GRANT CONNECT ON DATABASE %I TO {MAINTENANCE_ROLE}', current_database()
            );
            EXECUTE format('GRANT USAGE ON SCHEMA public TO {MAINTENANCE_ROLE}');
        END
        $$;
        """
    )
    op.execute(
        f"GRANT SELECT ON experiences, experience_versions, feedback, candidates, "
        f"retrieval_runs TO {MAINTENANCE_ROLE}"
    )
    op.execute(f"GRANT SELECT, UPDATE ON experiences, experience_versions TO {MAINTENANCE_ROLE}")
    op.execute(f"GRANT SELECT, INSERT ON audit_events TO {MAINTENANCE_ROLE}")
    op.execute(f"GRANT SELECT, INSERT ON evaluation_runs TO {MAINTENANCE_ROLE}")
    op.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {MAINTENANCE_ROLE}")


def downgrade() -> None:
    op.drop_table("evaluation_runs")
    if op.get_bind().dialect.name == "postgresql":
        op.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {MAINTENANCE_ROLE}")
        op.execute(f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {MAINTENANCE_ROLE}")
        op.execute(f"REVOKE ALL ON SCHEMA public FROM {MAINTENANCE_ROLE}")
        op.execute(f"DROP ROLE IF EXISTS {MAINTENANCE_ROLE}")
