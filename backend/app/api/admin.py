from fastapi import APIRouter, Depends, Request, HTTPException, Query
from pydantic import BaseModel

from app.api.auth import require_admin, verify_password, create_token
from app.crawler.crawler import CrawlerManager

admin_router = APIRouter(prefix="/api/admin", tags=["admin"])


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
    max_depth: int = 3


@admin_router.get("/sessions")
async def list_sessions(request: Request, _=Depends(require_admin)):
    crawler = _get_crawler(request)
    return await crawler.list_sessions()


@admin_router.post("/sessions")
async def create_session(body: CreateSessionRequest, request: Request, _=Depends(require_admin)):
    if body.seed_type not in ("search_query", "repository", "user"):
        raise HTTPException(status_code=400, detail="Invalid seed_type")
    if body.max_depth < 1 or body.max_depth > 5:
        raise HTTPException(status_code=400, detail="max_depth must be 1-5")
    crawler = _get_crawler(request)
    cs = await crawler.create_session(
        name=body.name,
        seed_type=body.seed_type,
        seed_value=body.seed_value,
        max_depth=body.max_depth,
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


# ── crawler control ──────────────────────────────────────

@admin_router.get("/crawler/status")
async def crawler_status(request: Request, _=Depends(require_admin)):
    crawler = _get_crawler(request)
    return await crawler.get_status()
