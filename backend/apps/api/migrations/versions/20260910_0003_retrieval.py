"""FTS, model-versioned embeddings and retrieval provenance."""

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects.postgresql import TSVECTOR

revision = "20260910_0003"
down_revision = "20260910_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("experience_versions", sa.Column("search_vector", TSVECTOR(), nullable=True))
    op.execute(
        "UPDATE experience_versions SET search_vector = to_tsvector('simple', payload::text)"
    )
    op.create_index(
        "ix_experience_fts", "experience_versions", ["search_vector"], postgresql_using="gin"
    )
    op.create_table(
        "embeddings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "version_id", sa.Integer(), sa.ForeignKey("experience_versions.id"), nullable=False
        ),
        sa.Column("index_version", sa.String(128), nullable=False),
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column("vector", Vector(1536), nullable=False),
        sa.UniqueConstraint("version_id", "index_version", name="uq_embedding_index"),
    )
    op.create_index(
        "ix_embeddings_hnsw",
        "embeddings",
        ["vector"],
        postgresql_using="hnsw",
        postgresql_ops={"vector": "vector_cosine_ops"},
    )
    op.execute("ALTER TABLE embeddings ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE embeddings FORCE ROW LEVEL SECURITY")
    expression = "EXISTS (SELECT 1 FROM experience_versions v WHERE v.id = version_id)"
    op.execute(
        f"CREATE POLICY embeddings_scope_policy ON embeddings "
        f"USING ({expression}) WITH CHECK ({expression})"
    )
    op.create_table(
        "retrieval_runs",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("organization_id", sa.String(128), nullable=False),
        sa.Column("team_id", sa.String(128)),
        sa.Column("project_id", sa.String(128)),
        sa.Column("personal_owner_id", sa.String(128)),
        sa.Column("actor_id", sa.String(128), nullable=False),
        sa.Column("task_id", sa.String(128), nullable=False),
        sa.Column("mode", sa.String(64), nullable=False),
        sa.Column("index_version", sa.String(128), nullable=False),
        sa.Column("items", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    for name in ("organization_id", "team_id", "project_id", "personal_owner_id"):
        op.create_index("ix_retrieval_runs_" + name, "retrieval_runs", [name])
    op.execute("ALTER TABLE retrieval_runs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE retrieval_runs FORCE ROW LEVEL SECURITY")
    scope = """organization_id = current_setting('app.organization_id', true)
    AND ((current_setting('app.personal_owner_id', true) <> ''
        AND personal_owner_id = current_setting('app.personal_owner_id', true))
      OR (current_setting('app.personal_owner_id', true) = '' AND personal_owner_id IS NULL
        AND (current_setting('app.team_id', true) = ''
             OR team_id = current_setting('app.team_id', true))
        AND (current_setting('app.project_id', true) = ''
             OR project_id = current_setting('app.project_id', true))))"""
    op.execute(
        f"CREATE POLICY retrieval_runs_scope_policy ON retrieval_runs "
        f"USING ({scope}) WITH CHECK ({scope})"
    )


def downgrade() -> None:
    op.drop_table("retrieval_runs")
    op.drop_table("embeddings")
    op.drop_index("ix_experience_fts", table_name="experience_versions")
    op.drop_column("experience_versions", "search_vector")
