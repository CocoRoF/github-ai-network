import time
from typing import Any

from app.config import settings


class GraphCache:
    def __init__(self, ttl: int | None = None):
        self._cache: dict[str, tuple[float, Any]] = {}
        self.ttl = ttl if ttl is not None else settings.graph_cache_ttl

    def get(self, key: str) -> Any | None:
        if key in self._cache:
            ts, data = self._cache[key]
            if time.time() - ts < self.ttl:
                return data
            del self._cache[key]
        return None

    def set(self, key: str, data: Any):
        self._cache[key] = (time.time(), data)

    def invalidate(self):
        self._cache.clear()

    def invalidate_by_session(self, session_id: int | None = None):
        """Invalidate caches related to a specific session.

        Also invalidates global views (session_id=None) since they
        aggregate data across all sessions.
        """
        if session_id is None:
            self.invalidate()
            return
        prefix = f"{session_id}:"
        keys_to_delete = [k for k in self._cache if k.startswith(prefix)]
        for k in keys_to_delete:
            del self._cache[k]
        # global views also stale when any session updates
        none_keys = [k for k in self._cache if k.startswith("None:")]
        for k in none_keys:
            del self._cache[k]


graph_cache = GraphCache()
