"""Static import provenance, versioned Markdown and idempotent commit receipts."""

import sqlalchemy as sa
from alembic import op

revision = "20260910_0002"
down_revision = "20260909_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("candidates", sa.Column("static_document", sa.JSON(), nullable=True))
    op.add_column("candidates", sa.Column("markdown_body", sa.Text(), nullable=True))
    op.add_column("candidates", sa.Column("target_experience_id", sa.String(128), nullable=True))
    op.add_column("candidates", sa.Column("base_version", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_candidate_target", "candidates", "experiences", ["target_experience_id"], ["id"]
    )
    op.add_column("experience_versions", sa.Column("markdown_body", sa.Text(), nullable=True))
    op.create_table(
        "static_files",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("candidate_id", sa.String(128), sa.ForeignKey("candidates.id"), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
    )
    op.create_table(
        "import_receipts",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("candidate_id", sa.String(128), sa.ForeignKey("candidates.id"), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
    )
    if op.get_bind().dialect.name == "postgresql":
        for table in ("static_files", "import_receipts"):
            op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
            op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
            expression = "EXISTS (SELECT 1 FROM candidates c WHERE c.id = candidate_id)"
            op.execute(
                f"CREATE POLICY {table}_scope_policy ON {table} "
                f"USING ({expression}) WITH CHECK ({expression})"
            )


def downgrade() -> None:
    op.drop_table("import_receipts")
    op.drop_table("static_files")
    op.drop_column("experience_versions", "markdown_body")
    op.drop_constraint("fk_candidate_target", "candidates", type_="foreignkey")
    for column in ("base_version", "target_experience_id", "markdown_body", "static_document"):
        op.drop_column("candidates", column)
