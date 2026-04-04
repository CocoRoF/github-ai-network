import httpx
from fastapi import APIRouter, Depends, Request, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, update

from app.api.auth import require_admin, verify_password, create_token
from app.config import settings
from app.crawler.crawler import CrawlerManager
from app.database import async_session_factory
from app.models import CrawlTask, CrawlSession

admin_router = APIRouter(prefix="/api/admin", tags=["admin"])


# ── lightweight GitHub API helper (no crawler delays) ────

async def _github_api_get(path: str):
    """Direct GitHub API call for validation — bypasses crawler rate-limit delays."""
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "GitHub-AI-Network-Crawler/1.0",
    }
    if settings.github_token:
        headers["Authorization"] = f"token {settings.github_token}"
    async with httpx.AsyncClient(
        base_url=settings.github_api_base, headers=headers, timeout=15.0,
        follow_redirects=True,
    ) as client:
        resp = await client.get(path)
        if resp.status_code == 200:
            return {"ok": True, "data": resp.json()}
        if resp.status_code == 403:
            remaining = resp.headers.get("X-RateLimit-Remaining", "?")
            return {"ok": False, "error": f"GitHub API rate limit exceeded (remaining: {remaining}). Try again later."}
        if resp.status_code == 404:
            return {"ok": False, "error": None}  # genuinely not found
        return {"ok": False, "error": f"GitHub API returned {resp.status_code}"}


# ── login ─────────────────────────────────────────────────

class LoginRequest(BaseModel):
    password: str


class LoginResponse(BaseModel):
    token: str


@admin_router.post("/login", response_model=LoginResponse)
async def admin_login(body: LoginRequest):
    if not verify_password(body.password):
        raise HTTPException(status_code=401, detail="Wrong password")
    return LoginResponse(token=create_token())


# ── helper to get crawler manager ─────────────────────────

def _get_crawler(request: Request) -> CrawlerManager:
    return request.app.state.crawler


# ── sessions ─────────────────────────────────────────────

class CreateSessionRequest(BaseModel):
    name: str
    seed_type: str  # search_query | repository | user
    seed_value: str


@admin_router.get("/sessions")
async def list_sessions(request: Request, _=Depends(require_admin)):
    crawler = _get_crawler(request)
    return await crawler.list_sessions()


@admin_router.post("/sessions")
async def create_session(body: CreateSessionRequest, request: Request, _=Depends(require_admin)):
    if body.seed_type not in ("search_query", "repository", "user"):
        raise HTTPException(status_code=400, detail="Invalid seed_type")
    crawler = _get_crawler(request)
    cs = await crawler.create_session(
        name=body.name,
        seed_type=body.seed_type,
        seed_value=body.seed_value,
    )
    return await crawler.get_session(cs.id)


@admin_router.get("/sessions/{session_id}")
async def get_session(session_id: int, request: Request, _=Depends(require_admin)):
    crawler = _get_crawler(request)
    s = await crawler.get_session(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    return s


@admin_router.post("/sessions/{session_id}/start")
async def start_session(session_id: int, request: Request, _=Depends(require_admin)):
    crawler = _get_crawler(request)
    await crawler.start_session(session_id)
    return {"status": "started"}


@admin_router.post("/sessions/{session_id}/pause")
async def pause_session(session_id: int, request: Request, _=Depends(require_admin)):
    crawler = _get_crawler(request)
    await crawler.pause_session(session_id)
    return {"status": "paused"}


@admin_router.delete("/sessions/{session_id}")
async def delete_session(session_id: int, request: Request, _=Depends(require_admin)):
    crawler = _get_crawler(request)
    await crawler.delete_session(session_id)
    return {"status": "deleted"}


@admin_router.get("/sessions/{session_id}/tasks")
async def get_session_tasks(
    session_id: int,
    request: Request,
    _=Depends(require_admin),
    status: str = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    crawler = _get_crawler(request)
    return await crawler.get_session_tasks(session_id, status=status, limit=limit, offset=offset)


# ── manual task injection ────────────────────────────────

class AddTaskRequest(BaseModel):
    task_type: str   # search_repos | fetch_repo | fetch_user
    target: str      # query string, owner/repo, or username
    priority: int = 500


class ValidateTargetRequest(BaseModel):
    task_type: str
    target: str


@admin_router.post("/sessions/{session_id}/tasks")
async def add_task_to_session(
    session_id: int,
    body: AddTaskRequest,
    request: Request,
    _=Depends(require_admin),
):
    """Manually inject a task into an existing session's queue."""
    if body.task_type not in ("search_repos", "fetch_repo", "fetch_user"):
        raise HTTPException(status_code=400, detail="Invalid task_type. Must be search_repos, fetch_repo, or fetch_user")
    if not body.target.strip():
        raise HTTPException(status_code=400, detail="Target cannot be empty")

    async with async_session_factory() as db:
        session = await db.get(CrawlSession, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        # Check if task already exists
        existing = await db.execute(
            select(CrawlTask).where(
                CrawlTask.session_id == session_id,
                CrawlTask.task_type == body.task_type,
                CrawlTask.target == body.target.strip(),
            )
        )
        if existing.scalar_one_or_none() is not None:
            raise HTTPException(status_code=409, detail="Task already exists in this session")

        task = CrawlTask(
            session_id=session_id,
            task_type=body.task_type,
            target=body.target.strip(),
            depth=0,
            priority=body.priority,
            status="pending",
        )
        db.add(task)
        await db.execute(
            update(CrawlSession)
            .where(CrawlSession.id == session_id)
            .values(tasks_pending=CrawlSession.tasks_pending + 1)
        )
        await db.commit()
        await db.refresh(task)

    # Log event and ensure worker is running
    crawler = _get_crawler(request)
    await crawler._log_event(
        "task_manual_add",
        f"Manual task added: {body.task_type} → {body.target.strip()}",
        session_id=session_id,
        metadata={"task_type": body.task_type, "target": body.target.strip(), "priority": body.priority},
    )
    crawler._ensure_worker()

    return {
        "id": task.id,
        "task_type": task.task_type,
        "target": task.target,
        "status": task.status,
        "priority": task.priority,
    }


@admin_router.post("/sessions/{session_id}/validate-target")
async def validate_target(
    session_id: int,
    body: ValidateTargetRequest,
    request: Request,
    _=Depends(require_admin),
):
    """Validate a target by checking it against GitHub API without adding to queue."""
    target = body.target.strip()
    if not target:
        raise HTTPException(status_code=400, detail="Target cannot be empty")

    try:
        if body.task_type == "fetch_repo":
            if "/" not in target:
                return {"valid": False, "error": "Repository must be in owner/repo format"}
            result = await _github_api_get(f"/repos/{target}")
            if not result["ok"]:
                return {"valid": False, "error": result["error"] or f"Repository '{target}' not found"}
            data = result["data"]
            return {
                "valid": True,
                "info": {
                    "full_name": data.get("full_name"),
                    "description": (data.get("description") or "")[:200],
                    "stars": data.get("stargazers_count", 0),
                    "language": data.get("language"),
                    "owner": data.get("owner", {}).get("login"),
                },
            }
        elif body.task_type == "fetch_user":
            result = await _github_api_get(f"/users/{target}")
            if not result["ok"]:
                return {"valid": False, "error": result["error"] or f"User '{target}' not found"}
            data = result["data"]
            return {
                "valid": True,
                "info": {
                    "login": data.get("login"),
                    "name": data.get("name"),
                    "bio": (data.get("bio") or "")[:200] or None,
                    "followers": data.get("followers", 0),
                    "public_repos": data.get("public_repos", 0),
                    "avatar_url": data.get("avatar_url"),
                },
            }
        elif body.task_type == "search_repos":
            result = await _github_api_get(f"/search/repositories?q={target}&sort=stars&per_page=3")
            if not result["ok"]:
                return {"valid": False, "error": result["error"] or "Search request failed"}
            data = result["data"]
            items = data.get("items", [])
            return {
                "valid": len(items) > 0,
                "info": {
                    "total_count": data.get("total_count", 0),
                    "sample": [
                        {"full_name": r.get("full_name"), "stars": r.get("stargazers_count", 0)}
                        for r in items[:3]
                    ],
                },
                "error": "No results found" if len(items) == 0 else None,
            }
        else:
            return {"valid": False, "error": "Invalid task_type"}
    except Exception as e:
        return {"valid": False, "error": str(e)}


# ── session logs ─────────────────────────────────────────

@admin_router.get("/sessions/{session_id}/logs")
async def get_session_logs(
    session_id: int,
    request: Request,
    _=Depends(require_admin),
    level: str = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    crawler = _get_crawler(request)
    return await crawler.get_logs(session_id=session_id, level=level, limit=limit, offset=offset)


# ── crawler control ──────────────────────────────────────

@admin_router.get("/crawler/status")
async def crawler_status(request: Request, _=Depends(require_admin)):
    crawler = _get_crawler(request)
    return await crawler.get_status()


@admin_router.get("/crawler/logs")
async def crawler_logs(
    request: Request,
    _=Depends(require_admin),
    level: str = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    crawler = _get_crawler(request)
    return await crawler.get_logs(level=level, limit=limit, offset=offset)


@admin_router.get("/crawler/logs/recent")
async def crawler_recent_logs(
    request: Request,
    _=Depends(require_admin),
    limit: int = Query(default=50, ge=1, le=200),
):
    """Fast in-memory log retrieval (no DB hit)."""
    crawler = _get_crawler(request)
    return crawler.get_recent_logs(limit=limit)


# ── depth stats ──────────────────────────────────────────

@admin_router.get("/sessions/{session_id}/depth-stats")
async def session_depth_stats(session_id: int, _=Depends(require_admin)):
    """Distribution of tasks by depth and status for monitoring crawl expansion."""
    async with async_session_factory() as db:
        result = await db.execute(
            select(
                CrawlTask.depth,
                CrawlTask.status,
                func.count(CrawlTask.id),
            )
            .where(CrawlTask.session_id == session_id)
            .group_by(CrawlTask.depth, CrawlTask.status)
            .order_by(CrawlTask.depth)
        )
        return {
            "session_id": session_id,
            "depth_distribution": [
                {"depth": row[0], "status": row[1], "count": row[2]}
                for row in result.all()
            ],
        }
