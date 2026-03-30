import asyncio
import logging
from datetime import datetime, timezone

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
        self.rate_limit_reset = 0
        self.delay = settings.crawler_delay

    async def _check_rate_limit(self, response: httpx.Response):
        remaining = response.headers.get("X-RateLimit-Remaining")
        reset = response.headers.get("X-RateLimit-Reset")

        if remaining is not None:
            self.rate_limit_remaining = int(remaining)
        if reset is not None:
            self.rate_limit_reset = int(reset)

        if self.rate_limit_remaining < 10:
            now_ts = datetime.now(timezone.utc).timestamp()
            wait = self.rate_limit_reset - now_ts
            if wait > 0:
                logger.warning(
                    "Rate limit nearly exhausted (%d remaining). Sleeping %.0fs",
                    self.rate_limit_remaining,
                    wait,
                )
                await asyncio.sleep(wait + 1)

    async def _request(self, method: str, url: str, **kwargs):
        await asyncio.sleep(self.delay)

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
                    await asyncio.sleep(wait + 1)
                    continue
                elif response.status_code == 404:
                    logger.debug("Not found: %s", url)
                    return None
                elif response.status_code == 422:
                    logger.warning("Validation error: %s – %s", url, response.text[:200])
                    return None
                else:
                    logger.error("HTTP %d: %s – %s", response.status_code, url, response.text[:200])
                    if attempt < 2:
                        await asyncio.sleep(5 * (attempt + 1))
                    continue

            except httpx.RequestError as exc:
                logger.error("Request error: %s – %s", url, exc)
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
