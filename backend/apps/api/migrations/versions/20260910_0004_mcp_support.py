"""PAT authentication, feedback and atomic task completion receipts."""

from alembic import op

revision = "20260910_0004"
down_revision = "20260910_0003"
branch_labels = None
depends_on = None


def upgrade():
    # These tables are new in this revision; freeze their definitions in the migration.
    import sqlalchemy as sa

    scope = ["organization_id", "team_id", "project_id", "personal_owner_id"]

    def scope_columns():
        return [
            sa.Column(name, sa.String(128), nullable=name != "organization_id") for name in scope
        ]

    op.create_table(
        "tokens",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("actor_id", sa.String(128), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("tools", sa.JSON(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        *scope_columns(),
    )
    op.create_table(
        "operations",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("id", sa.String(128), nullable=False),
        sa.Column("actor_id", sa.String(128), nullable=False),
        sa.Column("kind", sa.String(64), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        *scope_columns(),
    )
    op.create_table(
        "feedback",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("actor_id", sa.String(128), nullable=False),
        sa.Column("task_id", sa.String(128), nullable=False),
        sa.Column(
            "retrieval_id", sa.String(128), sa.ForeignKey("retrieval_runs.id"), nullable=False
        ),
        sa.Column("experience_id", sa.String(128), sa.ForeignKey("experiences.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("note", sa.String(500)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        *scope_columns(),
    )
    for table in ("tokens", "operations", "feedback"):
        for field in scope:
            op.create_index(f"ix_{table}_{field}", table, [field])
    expression = """organization_id = current_setting('app.organization_id', true)
    AND ((current_setting('app.personal_owner_id', true) <> ''
        AND personal_owner_id = current_setting('app.personal_owner_id', true))
      OR (current_setting('app.personal_owner_id', true) = '' AND personal_owner_id IS NULL
        AND (current_setting('app.team_id', true) = ''
          OR team_id = current_setting('app.team_id', true))
        AND (current_setting('app.project_id', true) = ''
          OR project_id = current_setting('app.project_id', true))))"""
    for table in ("operations", "feedback"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY {table}_scope_policy ON {table} "
            f"USING ({expression}) WITH CHECK ({expression})"
        )
    # PAT lookup happens before scope exists. SELECT is hash-indexed by the auth service;
    # token management checks authenticated actor + scope, and never returns hashes.


def downgrade():
    for table in ("feedback", "operations", "tokens"):
        op.drop_table(table)
