from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ACCREMIND_",
        env_file=".env",
        extra="ignore",
    )

    environment: str = "development"
    database_url: str = Field(
        default="postgresql+psycopg://accremind_app:accremind_app@localhost:5432/accremind"
    )
    migration_database_url: str = Field(
        default="postgresql+psycopg://accremind:accremind@localhost:5432/accremind"
    )
    # 周期治理任务用 BYPASSRLS 维护角色跨租户扫描，业务连接永不用它。
    maintenance_database_url: str = Field(
        default=(
            "postgresql+psycopg://accremind_maintenance:accremind_maintenance"
            "@localhost:5432/accremind"
        )
    )
    review_due_window_days: int = Field(default=30, ge=1)
    evaluation_dataset_path: str = "evals/retrieval-smoke.json"
    sql_echo: bool = False
    embedding_base_url: str | None = None
    embedding_api_key: SecretStr = SecretStr("")
    embedding_model: str = "text-embedding-3-small"
    embedding_index_version: str = "text-embedding-3-small-1536-v1"
    embedding_min_similarity: float = Field(default=0.3, ge=0, le=1)


@lru_cache
def get_settings() -> Settings:
    return Settings()
