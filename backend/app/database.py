import os
from pathlib import Path
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.config import settings, BASE_DIR

if settings.database_url.startswith("sqlite"):
    os.makedirs(BASE_DIR / "data", exist_ok=True)

engine = create_async_engine(settings.database_url, echo=False)
async_session_factory = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session_factory() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db():
    async with engine.begin() as conn:
        def _sync_check_and_create(sync_conn):
            from sqlalchemy import inspect, text as sa_text
            inspector = inspect(sync_conn)
            # If the old schema exists without new columns, drop and recreate
            if inspector.has_table("crawl_tasks"):
                columns = [c["name"] for c in inspector.get_columns("crawl_tasks")]
                if "session_id" not in columns:
                    Base.metadata.drop_all(sync_conn)
            Base.metadata.create_all(sync_conn)

            # ── incremental migrations ────────────────────
            if inspector.has_table("crawl_tasks"):
                columns = [c["name"] for c in inspector.get_columns("crawl_tasks")]
                if "retry_count" not in columns:
                    sync_conn.execute(sa_text(
                        "ALTER TABLE crawl_tasks ADD COLUMN retry_count INTEGER DEFAULT 0"
                    ))
                if "max_retries" not in columns:
                    sync_conn.execute(sa_text(
                        "ALTER TABLE crawl_tasks ADD COLUMN max_retries INTEGER DEFAULT 3"
                    ))
        await conn.run_sync(_sync_check_and_create)
