from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Author, Repository, Topic
from app.graph.builder import GraphBuilder

router = APIRouter()


# ── graph endpoints ──────────────────────────────────────

@router.get("/graph")
async def get_graph(
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=300, ge=1, le=2000),
    min_stars: int = Query(default=0, ge=0),
    search: str = Query(default=None),
    types: str = Query(default="author,repo,topic"),
):
    node_types = [t.strip() for t in types.split(",")]
    return await GraphBuilder.build_graph(
        db, limit=limit, min_stars=min_stars, node_types=node_types, search=search,
    )


@router.get("/graph/neighbors")
async def get_neighbors(
    node_id: str = Query(...),
    db: AsyncSession = Depends(get_db),
    depth: int = Query(default=1, ge=1, le=3),
):
    return await GraphBuilder.get_neighbors(db, node_id, depth=depth)


# ── search ───────────────────────────────────────────────

@router.get("/search")
async def search_nodes(
    q: str = Query(..., min_length=1, max_length=200),
    node_type: str = Query(default=None, alias="type"),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=100),
):
    results: list[dict] = []
    pattern = f"%{q}%"

    if node_type is None or node_type == "repo":
        rows = (
            await db.execute(
                select(Repository)
                .where(
                    Repository.full_name.ilike(pattern)
                    | Repository.description.ilike(pattern)
                )
                .order_by(Repository.stars.desc())
                .limit(limit)
            )
        ).scalars().all()
        for r in rows:
            results.append({
                "id": f"repo:{r.id}", "type": "repo",
                "label": r.full_name, "description": r.description,
                "stars": r.stars,
            })

    if node_type is None or node_type == "author":
        rows = (
            await db.execute(
                select(Author)
                .where(Author.login.ilike(pattern) | Author.name.ilike(pattern))
                .order_by(Author.followers.desc())
                .limit(limit)
            )
        ).scalars().all()
        for a in rows:
            results.append({
                "id": f"author:{a.id}", "type": "author",
                "label": a.login, "name": a.name,
                "followers": a.followers,
            })

    if node_type is None or node_type == "topic":
        rows = (
            await db.execute(
                select(Topic).where(Topic.name.ilike(pattern)).limit(limit)
            )
        ).scalars().all()
        for t in rows:
            results.append({
                "id": f"topic:{t.id}", "type": "topic", "label": t.name,
            })

    return {"results": results}


# ── stats ────────────────────────────────────────────────

@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    total_repos = (await db.execute(select(func.count(Repository.id)))).scalar() or 0
    total_authors = (await db.execute(select(func.count(Author.id)))).scalar() or 0
    total_topics = (await db.execute(select(func.count(Topic.id)))).scalar() or 0
    return {
        "total_repos": total_repos,
        "total_authors": total_authors,
        "total_topics": total_topics,
    }


# ── crawler control ──────────────────────────────────────

@router.get("/crawler/status")
async def crawler_status(request: Request):
    return await request.app.state.crawler.get_status()


@router.post("/crawler/start")
async def start_crawler(request: Request):
    await request.app.state.crawler.start()
    return {"status": "started"}


@router.post("/crawler/stop")
async def stop_crawler(request: Request):
    await request.app.state.crawler.stop()
    return {"status": "stopped"}
