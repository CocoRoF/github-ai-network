import os
from pathlib import Path
from pydantic_settings import BaseSettings

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    project_name: str = "GitHub AI Network"
    database_url: str = f"sqlite+aiosqlite:///{BASE_DIR / 'data' / 'github_ai_network.db'}"
    github_token: str = ""
    github_api_base: str = "https://api.github.com"
    crawler_delay: float = 2.0
    crawler_batch_size: int = 10
    crawler_auto_start: bool = False
    cors_origins: str = "http://localhost:5173,http://localhost:3000,http://localhost,http://localhost:58440"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
