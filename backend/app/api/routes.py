from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Author, Repository, Topic, RepoTopic, RepoContributor
from app.graph.builder import GraphBuilder

router = APIRouter()


# ── graph endpoints ──────────────────────────────────────

@router.get("/graph")
async def get_graph(
    request: Request,
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=300, ge=1, le=1000000),
    min_stars: int = Query(default=0, ge=0),
    search: str = Query(default=None),
    types: str = Query(default="author,repo,topic"),
    session_id: int = Query(default=None),
    language: str = Query(default=None),
    compact: bool = Query(default=False),
):
    node_types = [t.strip() for t in types.split(",")]

    # check cache
    cache = getattr(request.app.state, "graph_cache", None)
    cache_key = f"{session_id}:{limit}:{min_stars}:{types}:{search}:{language}:{compact}"
    if cache:
        cached = cache.get(cache_key)
        if cached:
            return cached

    result = await GraphBuilder.build_graph(
        db, limit=limit, min_stars=min_stars, node_types=node_types,
        search=search, session_id=session_id, language=language, compact=compact,
    )

    if cache:
        cache.set(cache_key, result)

    return result


@router.get("/graph/neighbors")
async def get_neighbors(
    node_id: str = Query(...),
    db: AsyncSession = Depends(get_db),
    depth: int = Query(default=1, ge=1, le=3),
):
    return await GraphBuilder.get_neighbors(db, node_id, depth=depth)


@router.get("/graph/node/{node_id:path}")
async def get_node_detail(
    node_id: str,
    db: AsyncSession = Depends(get_db),
):
    parts = node_id.split(":")
    if len(parts) != 2:
        return {"error": "Invalid node_id format"}

    node_type = parts[0]
    try:
        db_id = int(parts[1])
    except (ValueError, IndexError):
        return {"error": "Invalid node_id format"}

    if node_type == "repo":
        repo = (await db.execute(select(Repository).where(Repository.id == db_id))).scalar_one_or_none()
        if not repo:
            return {"error": "Not found"}

        result = {
            "id": node_id, "type": "repo", "label": repo.full_name,
            "description": repo.description, "stars": repo.stars,
            "forks": repo.forks_count, "language": repo.language,
            "license": repo.license_name,
            "watchers": repo.watchers,
            "open_issues": repo.open_issues,
            "is_fork": repo.is_fork,
            "homepage": repo.homepage,
            "default_branch": repo.default_branch,
            "repo_created_at": repo.repo_created_at.isoformat() if repo.repo_created_at else None,
            "repo_updated_at": repo.repo_updated_at.isoformat() if repo.repo_updated_at else None,
            "url": f"https://github.com/{repo.full_name}",
        }

        # Enrichment: top contributors
        contrib_rows = (await db.execute(
            select(RepoContributor, Author)
            .join(Author, RepoContributor.author_id == Author.id)
            .where(RepoContributor.repository_id == db_id)
            .order_by(RepoContributor.contributions.desc())
            .limit(10)
        )).all()
        result["contributors"] = [
            {
                "id": f"author:{a.id}", "login": a.login, "name": a.name,
                "avatar_url": a.avatar_url, "followers": a.followers or 0,
                "contributions": rc.contributions or 0,
            }
            for rc, a in contrib_rows
        ]

        # Enrichment: owner details
        if repo.owner_id:
            owner = (await db.execute(select(Author).where(Author.id == repo.owner_id))).scalar_one_or_none()
            if owner:
                result["owner"] = {
                    "id": f"author:{owner.id}", "login": owner.login, "name": owner.name,
                    "avatar_url": owner.avatar_url, "bio": owner.bio,
                    "followers": owner.followers or 0, "public_repos": owner.public_repos or 0,
                }
                # Owner's other repos (top 8 by stars, excluding current)
                other_repos = (await db.execute(
                    select(Repository)
                    .where(Repository.owner_id == repo.owner_id, Repository.id != db_id)
                    .order_by(Repository.stars.desc())
                    .limit(8)
                )).scalars().all()
                result["owner_repos"] = [
                    {
                        "id": f"repo:{r.id}", "label": r.full_name,
                        "stars": r.stars or 0, "language": r.language,
                        "description": (r.description or "")[:120],
                    }
                    for r in other_repos
                ]

        return result

    elif node_type == "author":
        author = (await db.execute(select(Author).where(Author.id == db_id))).scalar_one_or_none()
        if not author:
            return {"error": "Not found"}

        result = {
            "id": node_id, "type": "author", "label": author.login,
            "name": author.name, "bio": author.bio, "company": author.company,
            "location": author.location,
            "followers": author.followers, "following": author.following,
            "public_repos": author.public_repos,
            "avatar_url": author.avatar_url,
            "url": f"https://github.com/{author.login}",
        }

        # Enrichment: owned repos (top 10 by stars)
        owned = (await db.execute(
            select(Repository)
            .where(Repository.owner_id == db_id)
            .order_by(Repository.stars.desc())
            .limit(10)
        )).scalars().all()
        result["owned_repos"] = [
            {
                "id": f"repo:{r.id}", "label": r.full_name,
                "stars": r.stars or 0, "language": r.language,
                "description": (r.description or "")[:120],
            }
            for r in owned
        ]

        # Enrichment: contributed repos (top 10 by contributions, excluding owned)
        owned_ids = {r.id for r in owned}
        contrib_rows = (await db.execute(
            select(RepoContributor, Repository)
            .join(Repository, RepoContributor.repository_id == Repository.id)
            .where(RepoContributor.author_id == db_id)
            .order_by(RepoContributor.contributions.desc())
            .limit(15)
        )).all()
        result["contributed_repos"] = [
            {
                "id": f"repo:{r.id}", "label": r.full_name,
                "stars": r.stars or 0, "language": r.language,
                "contributions": rc.contributions or 0,
                "description": (r.description or "")[:120],
            }
            for rc, r in contrib_rows if r.id not in owned_ids
        ][:10]

        return result

    elif node_type == "topic":
        topic = (await db.execute(select(Topic).where(Topic.id == db_id))).scalar_one_or_none()
        if not topic:
            return {"error": "Not found"}
        repo_count = (await db.execute(
            select(func.count()).where(RepoTopic.topic_id == db_id)
        )).scalar() or 0

        # Enrichment: top repos with this topic
        top_repos = (await db.execute(
            select(Repository)
            .join(RepoTopic, RepoTopic.repository_id == Repository.id)
            .where(RepoTopic.topic_id == db_id)
            .order_by(Repository.stars.desc())
            .limit(8)
        )).scalars().all()

        return {
            "id": node_id, "type": "topic", "label": topic.name,
            "repo_count": repo_count,
            "top_repos": [
                {
                    "id": f"repo:{r.id}", "label": r.full_name,
                    "stars": r.stars or 0, "language": r.language,
                    "description": (r.description or "")[:120],
                }
                for r in top_repos
            ],
        }

    return {"error": "Unknown type"}


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


# ── public sessions list ────────────────────────────────

@router.get("/sessions")
async def public_sessions(request: Request):
    crawler = request.app.state.crawler
    return await crawler.list_sessions()


# ── public crawler status ────────────────────────────────

@router.get("/crawler/status")
async def crawler_status(request: Request):
    return await request.app.state.crawler.get_status()
