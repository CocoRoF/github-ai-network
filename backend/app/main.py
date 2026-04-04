import logging
import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.database import init_db, async_session_factory
from app.api.routes import router
from app.api.admin import admin_router
from app.crawler.crawler import CrawlerManager
from app.graph.cache import graph_cache

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── rate limiting state ──────────────────────────────────
_rate_limit_store: dict[str, list[float]] = defaultdict(list)
RATE_LIMIT_WINDOW = 60   # seconds
RATE_LIMIT_MAX = 120      # max requests per window per IP

crawler = CrawlerManager()
crawler._invalidate_cache_fn = graph_cache.invalidate


async def _recover_orphaned_tasks():
    """Reset tasks stuck in 'processing' state back to 'pending' after restart."""
    from sqlalchemy import update as sa_update
    from app.models import CrawlTask
    async with async_session_factory() as session:
        result = await session.execute(
            sa_update(CrawlTask)
            .where(CrawlTask.status == "processing")
            .values(status="pending")
        )
        await session.commit()
        if result.rowcount:
            logger.info("Recovered %d orphaned tasks → pending", result.rowcount)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing database …")
    await init_db()
    logger.info("Recovering orphaned tasks …")
    await _recover_orphaned_tasks()
    logger.info("Checking for sessions to auto-resume …")
    await crawler.auto_resume()
    yield
    logger.info("Shutting down …")
    await crawler.close()


app = FastAPI(title=settings.project_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Simple IP-based rate limiting."""
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    # prune old entries
    timestamps = _rate_limit_store[client_ip]
    cutoff = now - RATE_LIMIT_WINDOW
    _rate_limit_store[client_ip] = [t for t in timestamps if t > cutoff]
    if len(_rate_limit_store[client_ip]) >= RATE_LIMIT_MAX:
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many requests. Please try again later."},
        )
    _rate_limit_store[client_ip].append(now)
    return await call_next(request)


app.include_router(router, prefix="/api")
app.include_router(admin_router)
app.state.crawler = crawler
app.state.graph_cache = graph_cache
