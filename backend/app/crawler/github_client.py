import asyncio
import logging
from datetime import datetime, timezone
from typing import Callable, Awaitable

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class GitHubClient:
    def __init__(self):
        headers = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "GitHub-AI-Network-Crawler/1.0",
        }
        if settings.github_token:
            headers["Authorization"] = f"token {settings.github_token}"

        self.client = httpx.AsyncClient(
            base_url=settings.github_api_base,
            headers=headers,
            timeout=30.0,
        )
        self.rate_limit_remaining = 5000
        self.rate_limit_limit = 5000
        self.rate_limit_reset = 0
        self.rate_limit_waiting = False
        self.total_api_calls = 0
        self.delay = settings.crawler_delay

        # optional async callbacks set by CrawlerManager
        self._on_rate_limit_wait: Callable[[int, float], Awaitable] | None = None
        self._on_rate_limit_resume: Callable[[], Awaitable] | None = None
        self._on_api_error: Callable[[str, int, str], Awaitable] | None = None

    @property
    def rate_limit_reset_dt(self) -> datetime | None:
        if self.rate_limit_reset:
            return datetime.fromtimestamp(self.rate_limit_reset, tz=timezone.utc)
        return None

    async def _check_rate_limit(self, response: httpx.Response):
        remaining = response.headers.get("X-RateLimit-Remaining")
        reset = response.headers.get("X-RateLimit-Reset")
        limit = response.headers.get("X-RateLimit-Limit")

        if remaining is not None:
            self.rate_limit_remaining = int(remaining)
        if reset is not None:
            self.rate_limit_reset = int(reset)
        if limit is not None:
            self.rate_limit_limit = int(limit)

        if self.rate_limit_remaining < 10:
            now_ts = datetime.now(timezone.utc).timestamp()
            wait = self.rate_limit_reset - now_ts
            if wait > 0:
                logger.warning(
                    "Rate limit nearly exhausted (%d remaining). Sleeping %.0fs",
                    self.rate_limit_remaining,
                    wait,
                )
                self.rate_limit_waiting = True
                if self._on_rate_limit_wait:
                    await self._on_rate_limit_wait(self.rate_limit_remaining, wait)
                await asyncio.sleep(wait + 1)
                self.rate_limit_waiting = False
                if self._on_rate_limit_resume:
                    await self._on_rate_limit_resume()

    async def _request(self, method: str, url: str, **kwargs):
        await asyncio.sleep(self.delay)
        self.total_api_calls += 1

        for attempt in range(3):
            try:
                response = await self.client.request(method, url, **kwargs)
                await self._check_rate_limit(response)

                if response.status_code == 200:
                    return response.json()
                elif response.status_code == 403:
                    now_ts = datetime.now(timezone.utc).timestamp()
                    wait = max(self.rate_limit_reset - now_ts, 60)
                    logger.warning("403 Forbidden on %s. Sleeping %.0fs", url, wait)
                    self.rate_limit_waiting = True
                    if self._on_rate_limit_wait:
                        await self._on_rate_limit_wait(0, wait)
                    await asyncio.sleep(wait + 1)
                    self.rate_limit_waiting = False
                    if self._on_rate_limit_resume:
                        await self._on_rate_limit_resume()
                    continue
                elif response.status_code == 404:
                    logger.debug("Not found: %s", url)
                    return None
                elif response.status_code == 422:
                    logger.warning("Validation error: %s – %s", url, response.text[:200])
                    if self._on_api_error:
                        await self._on_api_error(url, 422, response.text[:200])
                    return None
                else:
                    logger.error("HTTP %d: %s – %s", response.status_code, url, response.text[:200])
                    if self._on_api_error:
                        await self._on_api_error(url, response.status_code, response.text[:200])
                    if attempt < 2:
                        await asyncio.sleep(5 * (attempt + 1))
                    continue

            except httpx.RequestError as exc:
                logger.error("Request error: %s – %s", url, exc)
                if self._on_api_error:
                    await self._on_api_error(url, 0, str(exc))
                if attempt < 2:
                    await asyncio.sleep(5 * (attempt + 1))
                    continue
                return None

        logger.error("All retries exhausted for %s", url)
        return None

    async def get(self, url: str, **kwargs):
        return await self._request("GET", url, **kwargs)

    async def search_repositories(self, query: str, sort: str = "stars",
                                  per_page: int = 30, page: int = 1):
        return await self.get(
            "/search/repositories",
            params={"q": query, "sort": sort, "per_page": per_page, "page": page},
        )

    async def get_repository(self, full_name: str):
        return await self.get(f"/repos/{full_name}")

    async def get_repo_contributors(self, full_name: str,
                                    per_page: int = 30, page: int = 1):
        return await self.get(
            f"/repos/{full_name}/contributors",
            params={"per_page": per_page, "page": page},
        )

    async def get_user(self, login: str):
        return await self.get(f"/users/{login}")

    async def get_user_repos(self, login: str, sort: str = "stars",
                             per_page: int = 30, page: int = 1):
        return await self.get(
            f"/users/{login}/repos",
            params={"sort": sort, "per_page": per_page, "page": page, "type": "owner"},
        )

    async def close(self):
        await self.client.aclose()
