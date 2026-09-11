"""Durable worker outbox and candidate duplicate suggestions."""

import sqlalchemy as sa
from alembic import op

revision = "20260910_0005"
down_revision = "20260910_0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "candidates",
        sa.Column("duplicate_suggestions", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.create_table(
        "jobs",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("kind", sa.String(64), nullable=False),
        sa.Column("entity_id", sa.String(128), nullable=False),
        sa.Column("scope", sa.JSON(), nullable=False),
        sa.Column("state", sa.String(32), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("error_code", sa.String(128)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("jobs")
    op.drop_column("candidates", "duplicate_suggestions")
