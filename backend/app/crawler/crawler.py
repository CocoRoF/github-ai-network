import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory
from app.models import (
    Author, Repository, Topic, RepoTopic, RepoContributor, CrawlTask,
)
from app.crawler.github_client import GitHubClient
from app.crawler.seeds import AI_SEARCH_QUERIES, AI_TOPICS, AI_KEYWORDS

logger = logging.getLogger(__name__)


class GitHubCrawler:
    def __init__(self):
        self.client = GitHubClient()
        self.running = False
        self._task: asyncio.Task | None = None

    # ── queue helpers ──────────────────────────────────────

    async def seed_queue(self):
        async with async_session_factory() as session:
            for i, query in enumerate(AI_SEARCH_QUERIES):
                await self._add_task(
                    session, "search_repos", query, priority=1000 - i
                )
            await session.commit()
            logger.info("Seeded %d search tasks", len(AI_SEARCH_QUERIES))

    async def _add_task(
        self, session: AsyncSession, task_type: str, target: str, priority: int = 0
    ):
        existing = await session.execute(
            select(CrawlTask).where(
                CrawlTask.task_type == task_type,
                CrawlTask.target == target,
            )
        )
        if existing.scalar_one_or_none() is None:
            session.add(
                CrawlTask(
                    task_type=task_type,
                    target=target,
                    priority=priority,
                    status="pending",
                )
            )

    async def _next_task(self, session: AsyncSession) -> CrawlTask | None:
        result = await session.execute(
            select(CrawlTask)
            .where(CrawlTask.status == "pending")
            .order_by(CrawlTask.priority.desc(), CrawlTask.created_at.asc())
            .limit(1)
        )
        task = result.scalar_one_or_none()
        if task:
            task.status = "processing"
            await session.commit()
        return task

    # ── lifecycle ──────────────────────────────────────────

    async def start(self):
        if self.running:
            return
        self.running = True
        self._task = asyncio.create_task(self._run())
        logger.info("Crawler started")

    async def stop(self):
        self.running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("Crawler stopped")

    async def close(self):
        await self.stop()
        await self.client.close()

    # ── main loop ─────────────────────────────────────────

    async def _run(self):
        await self.seed_queue()

        while self.running:
            try:
                async with async_session_factory() as session:
                    task = await self._next_task(session)
                    if task is None:
                        logger.info("No pending tasks – sleeping 30 s")
                        await asyncio.sleep(30)
                        continue

                    try:
                        count = await self._process(session, task)
                        task.status = "done"
                        task.result_count = count
                    except Exception as exc:
                        task.status = "error"
                        task.error_message = str(exc)[:500]
                        logger.error("Task %d error: %s", task.id, exc)

                    task.processed_at = datetime.now(timezone.utc)
                    await session.commit()

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error("Crawler loop error: %s", exc)
                await asyncio.sleep(10)

    # ── task dispatcher ───────────────────────────────────

    async def _process(self, session: AsyncSession, task: CrawlTask) -> int:
        logger.info("Processing [%s] %s", task.task_type, task.target)
        handlers = {
            "search_repos": self._do_search_repos,
            "fetch_repo": self._do_fetch_repo,
            "fetch_user": self._do_fetch_user,
            "fetch_contributors": self._do_fetch_contributors,
        }
        handler = handlers.get(task.task_type)
        if handler is None:
            logger.warning("Unknown task type: %s", task.task_type)
            return 0
        return await handler(session, task.target)

    # ── search_repos ──────────────────────────────────────

    async def _do_search_repos(self, session: AsyncSession, query: str) -> int:
        count = 0
        for page in range(1, 4):
            data = await self.client.search_repositories(query, per_page=30, page=page)
            if not data or "items" not in data:
                break
            for item in data["items"]:
                repo = await self._save_repo(session, item)
                if repo:
                    count += 1
                    await self._add_task(
                        session,
                        "fetch_contributors",
                        item["full_name"],
                        priority=min(item.get("stargazers_count", 0), 10000),
                    )
            if len(data["items"]) < 30:
                break
        await session.commit()
        return count

    # ── fetch_repo ────────────────────────────────────────

    async def _do_fetch_repo(self, session: AsyncSession, full_name: str) -> int:
        data = await self.client.get_repository(full_name)
        if not data:
            return 0

        repo = await self._save_repo(session, data)
        if not repo:
            return 0

        if data.get("owner"):
            await self._add_task(
                session, "fetch_user", data["owner"]["login"], priority=100
            )

        if data.get("fork") and data.get("parent"):
            parent_data = data["parent"]
            parent_repo = await self._save_repo(session, parent_data)
            if parent_repo:
                repo.fork_source_id = parent_repo.id
            await self._add_task(
                session, "fetch_repo", parent_data["full_name"], priority=500
            )

        await session.commit()
        return 1

    # ── fetch_user ────────────────────────────────────────

    async def _do_fetch_user(self, session: AsyncSession, login: str) -> int:
        data = await self.client.get_user(login)
        if not data:
            return 0

        await self._save_author(session, data, detailed=True)

        repos_data = await self.client.get_user_repos(login, per_page=30)
        count = 1
        if repos_data and isinstance(repos_data, list):
            for rd in repos_data:
                if self._is_ai_related(rd):
                    await self._save_repo(session, rd)
                    count += 1

        await session.commit()
        return count

    # ── fetch_contributors ────────────────────────────────

    async def _do_fetch_contributors(self, session: AsyncSession, full_name: str) -> int:
        data = await self.client.get_repo_contributors(full_name, per_page=15)
        if not data or not isinstance(data, list):
            return 0

        result = await session.execute(
            select(Repository).where(Repository.full_name == full_name)
        )
        repo = result.scalar_one_or_none()
        if not repo:
            return 0

        count = 0
        for cd in data:
            author = await self._save_author(session, cd)
            if not author:
                continue

            existing = await session.execute(
                select(RepoContributor).where(
                    RepoContributor.repository_id == repo.id,
                    RepoContributor.author_id == author.id,
                )
            )
            if existing.scalar_one_or_none() is None:
                session.add(
                    RepoContributor(
                        repository_id=repo.id,
                        author_id=author.id,
                        contributions=cd.get("contributions", 0),
                    )
                )

            await self._add_task(
                session,
                "fetch_user",
                cd["login"],
                priority=min(cd.get("contributions", 0), 1000),
            )
            count += 1

        await session.commit()
        return count

    # ── persistence helpers ───────────────────────────────

    async def _save_author(
        self, session: AsyncSession, data: dict, detailed: bool = False
    ) -> Author | None:
        if not data or "id" not in data:
            return None

        result = await session.execute(
            select(Author).where(Author.github_id == data["id"])
        )
        author = result.scalar_one_or_none()

        if author is None:
            author = Author(
                github_id=data["id"],
                login=data["login"],
                avatar_url=data.get("avatar_url"),
                user_type=data.get("type", "User"),
            )
            session.add(author)

        if detailed:
            author.name = data.get("name")
            author.bio = data.get("bio")
            author.company = data.get("company")
            author.location = data.get("location")
            author.followers = data.get("followers", 0)
            author.following = data.get("following", 0)
            author.public_repos = data.get("public_repos", 0)
            author.crawled_at = datetime.now(timezone.utc)

        await session.flush()
        return author

    async def _save_repo(
        self, session: AsyncSession, data: dict
    ) -> Repository | None:
        if not data or "id" not in data:
            return None

        result = await session.execute(
            select(Repository).where(Repository.github_id == data["id"])
        )
        repo = result.scalar_one_or_none()

        owner = None
        if data.get("owner"):
            owner = await self._save_author(session, data["owner"])

        if repo is None:
            repo = Repository(
                github_id=data["id"],
                full_name=data["full_name"],
                name=data["name"],
                description=data.get("description"),
                owner_id=owner.id if owner else None,
                stars=data.get("stargazers_count", 0),
                forks_count=data.get("forks_count", 0),
                watchers=data.get("watchers_count", 0),
                open_issues=data.get("open_issues_count", 0),
                language=data.get("language"),
                license_name=(
                    data["license"].get("spdx_id") if data.get("license") else None
                ),
                is_fork=data.get("fork", False),
                homepage=data.get("homepage"),
                default_branch=data.get("default_branch", "main"),
            )
            session.add(repo)
        else:
            repo.stars = data.get("stargazers_count", repo.stars)
            repo.forks_count = data.get("forks_count", repo.forks_count)
            repo.watchers = data.get("watchers_count", repo.watchers)
            repo.description = data.get("description") or repo.description

        for json_key, attr in [
            ("created_at", "repo_created_at"),
            ("updated_at", "repo_updated_at"),
        ]:
            val = data.get(json_key)
            if val:
                try:
                    setattr(
                        repo, attr,
                        datetime.fromisoformat(val.replace("Z", "+00:00")),
                    )
                except (ValueError, TypeError):
                    pass

        repo.crawled_at = datetime.now(timezone.utc)
        await session.flush()

        # topics
        for topic_name in data.get("topics", []):
            t_result = await session.execute(
                select(Topic).where(Topic.name == topic_name)
            )
            topic = t_result.scalar_one_or_none()
            if topic is None:
                topic = Topic(name=topic_name)
                session.add(topic)
                await session.flush()

            link_exists = await session.execute(
                select(RepoTopic).where(
                    RepoTopic.repository_id == repo.id,
                    RepoTopic.topic_id == topic.id,
                )
            )
            if link_exists.scalar_one_or_none() is None:
                session.add(RepoTopic(repository_id=repo.id, topic_id=topic.id))

        return repo

    # ── utility ───────────────────────────────────────────

    @staticmethod
    def _is_ai_related(repo_data: dict) -> bool:
        topics = repo_data.get("topics", [])
        desc = (repo_data.get("description") or "").lower()
        name = repo_data.get("name", "").lower()

        if any(t in AI_TOPICS for t in topics):
            return True
        if any(kw in desc for kw in AI_KEYWORDS):
            return True
        if any(kw in name for kw in ["ml", "ai", "neural", "llm", "gpt", "bert", "transformer"]):
            return True
        if repo_data.get("stargazers_count", 0) > 500:
            return True
        return False

    # ── status ────────────────────────────────────────────

    async def get_status(self) -> dict:
        async with async_session_factory() as session:
            pending = (await session.execute(
                select(func.count(CrawlTask.id)).where(CrawlTask.status == "pending")
            )).scalar() or 0
            done = (await session.execute(
                select(func.count(CrawlTask.id)).where(CrawlTask.status == "done")
            )).scalar() or 0
            errors = (await session.execute(
                select(func.count(CrawlTask.id)).where(CrawlTask.status == "error")
            )).scalar() or 0
            total_repos = (await session.execute(
                select(func.count(Repository.id))
            )).scalar() or 0
            total_authors = (await session.execute(
                select(func.count(Author.id))
            )).scalar() or 0
            total_topics = (await session.execute(
                select(func.count(Topic.id))
            )).scalar() or 0

        return {
            "running": self.running,
            "tasks_pending": pending,
            "tasks_done": done,
            "tasks_errors": errors,
            "total_repos": total_repos,
            "total_authors": total_authors,
            "total_topics": total_topics,
            "rate_limit_remaining": self.client.rate_limit_remaining,
        }
