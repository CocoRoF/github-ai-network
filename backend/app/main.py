import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import init_db
from app.api.routes import router
from app.api.admin import admin_router
from app.crawler.crawler import CrawlerManager
from app.graph.cache import graph_cache

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

crawler = CrawlerManager()
crawler._invalidate_cache_fn = graph_cache.invalidate


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing database …")
    await init_db()
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

app.include_router(router, prefix="/api")
app.include_router(admin_router)
app.state.crawler = crawler
app.state.graph_cache = graph_cache
