import uvicorn
from fastapi import FastAPI

from .routers import candidates, experiences, health, retrieval
from .settings import get_settings

OPENAPI_TAGS = [
    {"name": "health", "description": "服务存活与数据库连接状态。"},
    {"name": "candidates", "description": "候选经验的提交、预处理和人工发布。"},
    {"name": "experiences", "description": "已发布经验及其不可变版本查询。"},
    {"name": "retrieval", "description": "在权限和 token 预算内召回已发布经验。"},
]


def create_app() -> FastAPI:
    """创建 Core API 应用；测试可通过依赖覆盖替换数据库会话。"""

    settings = get_settings()
    app = FastAPI(
        title="AccreMind Core API",
        description=(
            "面向 Coding Agent 的经验闭环核心 API。当前版本提供候选提交、人工发布、"
            "经验查询和基础召回；开发态身份通过 X-* 请求头传入。"
        ),
        version="0.1.0",
        openapi_tags=OPENAPI_TAGS,
        docs_url="/docs" if settings.environment != "production" else None,
        redoc_url=None,
    )
    app.include_router(health.router)
    app.include_router(candidates.router)
    app.include_router(experiences.router)
    app.include_router(retrieval.router)
    return app


app = create_app()


def run() -> None:
    """以本地开发模式启动 API。"""

    uvicorn.run("accremind_api.main:app", host="127.0.0.1", port=8000, reload=True)
