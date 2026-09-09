from functools import lru_cache

from pydantic import Field
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
    sql_echo: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
