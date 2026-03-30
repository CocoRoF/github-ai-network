import secrets
import time

from fastapi import Request, HTTPException

from app.config import settings

# In-memory token store: {token: created_at_timestamp}
_tokens: dict[str, float] = {}
TOKEN_TTL = 86400  # 24 hours


def create_token() -> str:
    token = secrets.token_urlsafe(32)
    _tokens[token] = time.time()
    # cleanup expired tokens
    now = time.time()
    expired = [t for t, ts in _tokens.items() if now - ts > TOKEN_TTL]
    for t in expired:
        _tokens.pop(t, None)
    return token


def verify_password(password: str) -> bool:
    return secrets.compare_digest(password, settings.admin_password)


async def require_admin(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = auth[7:]
    ts = _tokens.get(token)
    if ts is None or time.time() - ts > TOKEN_TTL:
        _tokens.pop(token, None)
        raise HTTPException(status_code=401, detail="Invalid or expired token")
