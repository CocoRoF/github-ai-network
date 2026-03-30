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


graph_cache = GraphCache()
