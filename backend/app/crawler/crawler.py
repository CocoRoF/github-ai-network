import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory
from app.models import (
    Author, Repository, Topic, RepoTopic, RepoContributor,
    CrawlTask, CrawlSession, SessionRepository, SessionAuthor,
)
from app.crawler.github_client import GitHubClient
from app.crawler.seeds import AI_TOPICS, AI_KEYWORDS

logger = logging.getLogger(__name__)


class CrawlerManager:
    """Manages multiple crawl sessions with a single worker."""

    def __init__(self):
        self.client = GitHubClient()
        self._worker: asyncio.Task | None = None
        self._last_error: str | None = None
        self._invalidate_cache_fn = None  # set by main.py

    @property
    def worker_running(self) -> bool:
        return self._worker is not None and not self._worker.done()

    # ── session management ────────────────────────────────

    async def create_session(
        self, name: str, seed_type: str, seed_value: str,
    ) -> CrawlSession:
        async with async_session_factory() as session:
            cs = CrawlSession(
                name=name,
                seed_type=seed_type,
                seed_value=seed_value,
                status="running",
                tasks_pending=1,
            )
            session.add(cs)
            await session.flush()

            # create initial seed task at depth=0
            if seed_type == "search_query":
                task_type = "search_repos"
            elif seed_type == "repository":
                task_type = "fetch_repo"
            elif seed_type == "user":
                task_type = "fetch_user"
            else:
                task_type = "search_repos"

            session.add(CrawlTask(
                session_id=cs.id,
                task_type=task_type,
                target=seed_value,
                depth=0,
                priority=1000,
                status="pending",
            ))
            await session.commit()
            await session.refresh(cs)
            logger.info("Created session %d: %s (%s: %s)", cs.id, name, seed_type, seed_value)

        self._ensure_worker()
        return cs

    async def start_session(self, session_id: int):
        async with async_session_factory() as session:
            cs = await session.get(CrawlSession, session_id)
            if cs:
                cs.status = "running"
                cs.paused_at = None
                await session.commit()
        self._ensure_worker()

    async def pause_session(self, session_id: int):
        async with async_session_factory() as session:
            cs = await session.get(CrawlSession, session_id)
            if cs:
                cs.status = "paused"
                cs.paused_at = datetime.now(timezone.utc)
                await session.commit()

    async def delete_session(self, session_id: int):
        async with async_session_factory() as session:
            cs = await session.get(CrawlSession, session_id)
            if cs:
                # delete junction tables
                await session.execute(
                    SessionRepository.__table__.delete().where(
                        SessionRepository.session_id == session_id
                    )
                )
                await session.execute(
                    SessionAuthor.__table__.delete().where(
                        SessionAuthor.session_id == session_id
                    )
                )
                await session.delete(cs)
                await session.commit()

    async def get_session(self, session_id: int) -> dict | None:
        async with async_session_factory() as session:
            cs = await session.get(CrawlSession, session_id)
            if not cs:
                return None
            return self._session_to_dict(cs)

    async def list_sessions(self) -> list[dict]:
        async with async_session_factory() as session:
            result = await session.execute(
                select(CrawlSession).order_by(CrawlSession.created_at.desc())
            )
            return [self._session_to_dict(cs) for cs in result.scalars().all()]

    async def get_session_tasks(
        self, session_id: int, status: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> list[dict]:
        async with async_session_factory() as session:
            q = select(CrawlTask).where(CrawlTask.session_id == session_id)
            if status:
                q = q.where(CrawlTask.status == status)
            q = q.order_by(CrawlTask.processed_at.desc().nullslast(), CrawlTask.created_at.desc())
            q = q.limit(limit).offset(offset)
            result = await session.execute(q)
            return [
                {
                    "id": t.id,
                    "task_type": t.task_type,
                    "target": t.target,
                    "depth": t.depth,
                    "status": t.status,
                    "result_count": t.result_count,
                    "error_message": t.error_message,
                    "created_at": t.created_at.isoformat() if t.created_at else None,
                    "processed_at": t.processed_at.isoformat() if t.processed_at else None,
                }
                for t in result.scalars().all()
            ]

    @staticmethod
    def _session_to_dict(cs: CrawlSession) -> dict:
        return {
            "id": cs.id,
            "name": cs.name,
            "seed_type": cs.seed_type,
            "seed_value": cs.seed_value,
            "status": cs.status,
            "total_repos": cs.total_repos,
            "total_authors": cs.total_authors,
            "tasks_pending": cs.tasks_pending,
            "tasks_done": cs.tasks_done,
            "tasks_errors": cs.tasks_errors,
            "created_at": cs.created_at.isoformat() if cs.created_at else None,
            "updated_at": cs.updated_at.isoformat() if cs.updated_at else None,
            "paused_at": cs.paused_at.isoformat() if cs.paused_at else None,
        }

    # ── worker lifecycle ──────────────────────────────────

    def _ensure_worker(self):
        if not self.worker_running:
            self._worker = asyncio.create_task(self._run())
            self._worker.add_done_callback(self._on_worker_done)
            logger.info("Worker started")

    def _on_worker_done(self, task: asyncio.Task):
        if task.cancelled():
            logger.info("Worker cancelled")
        elif task.exception():
            exc = task.exception()
            self._last_error = f"Worker crashed: {exc}"
            logger.error("Worker crashed: %s", exc, exc_info=exc)
        else:
            logger.info("Worker finished (no more tasks)")

    async def stop_worker(self):
        if self._worker:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None
        logger.info("Worker stopped")

    async def close(self):
        await self.stop_worker()
        await self.client.close()

    # ── main worker loop ──────────────────────────────────

    async def _run(self):
        while True:
            try:
                async with async_session_factory() as session:
                    task = await self._next_task(session)
                    if task is None:
                        # check if any sessions are still running
                        running = (await session.execute(
                            select(func.count(CrawlSession.id)).where(
                                CrawlSession.status == "running"
                            )
                        )).scalar() or 0
                        if running == 0:
                            logger.info("No running sessions — worker exiting")
                            return
                        logger.debug("No pending tasks — sleeping 15s")
                        await asyncio.sleep(15)
                        continue

                    session_id = task.session_id
                    try:
                        count = await self._process(session, task)
                        task.status = "done"
                        task.result_count = count
                        # update session counters
                        await session.execute(
                            update(CrawlSession)
                            .where(CrawlSession.id == session_id)
                            .values(
                                tasks_pending=CrawlSession.tasks_pending - 1,
                                tasks_done=CrawlSession.tasks_done + 1,
                            )
                        )
                        logger.info(
                            "Task %d [%s] session=%d done — %d items",
                            task.id, task.task_type, session_id, count,
                        )
                    except Exception as exc:
                        task.status = "error"
                        task.error_message = str(exc)[:500]
                        self._last_error = f"Task {task.id} [{task.task_type}]: {exc}"
                        await session.execute(
                            update(CrawlSession)
                            .where(CrawlSession.id == session_id)
                            .values(
                                tasks_pending=CrawlSession.tasks_pending - 1,
                                tasks_errors=CrawlSession.tasks_errors + 1,
                            )
                        )
                        logger.error(
                            "Task %d [%s] error: %s",
                            task.id, task.task_type, exc, exc_info=True,
                        )

                    task.processed_at = datetime.now(timezone.utc)
                    await session.commit()

                    if self._invalidate_cache_fn:
                        self._invalidate_cache_fn()

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_error = f"Loop error: {exc}"
                logger.error("Worker loop error: %s", exc, exc_info=True)
                await asyncio.sleep(10)

    # ── task helpers ──────────────────────────────────────

    async def _next_task(self, session: AsyncSession) -> CrawlTask | None:
        # get IDs of running sessions
        running_ids = (await session.execute(
            select(CrawlSession.id).where(CrawlSession.status == "running")
        )).scalars().all()
        if not running_ids:
            return None

        result = await session.execute(
            select(CrawlTask)
            .where(
                CrawlTask.status == "pending",
                CrawlTask.session_id.in_(running_ids),
            )
            .order_by(CrawlTask.priority.desc(), CrawlTask.created_at.asc())
            .limit(1)
        )
        task = result.scalar_one_or_none()
        if task:
            task.status = "processing"
            await session.commit()
        return task

    async def _add_task(
        self,
        session: AsyncSession,
        session_id: int,
        task_type: str,
        target: str,
        depth: int = 0,
        priority: int = 0,
    ):
        existing = await session.execute(
            select(CrawlTask).where(
                CrawlTask.session_id == session_id,
                CrawlTask.task_type == task_type,
                CrawlTask.target == target,
            )
        )
        if existing.scalar_one_or_none() is None:
            session.add(
                CrawlTask(
                    session_id=session_id,
                    task_type=task_type,
                    target=target,
                    depth=depth,
                    priority=priority,
                    status="pending",
                )
            )
            await session.execute(
                update(CrawlSession)
                .where(CrawlSession.id == session_id)
                .values(tasks_pending=CrawlSession.tasks_pending + 1)
            )

    async def _link_session_repo(self, session: AsyncSession, session_id: int, repo_id: int):
        existing = await session.execute(
            select(SessionRepository).where(
                SessionRepository.session_id == session_id,
                SessionRepository.repository_id == repo_id,
            )
        )
        if existing.scalar_one_or_none() is None:
            session.add(SessionRepository(session_id=session_id, repository_id=repo_id))
            await session.execute(
                update(CrawlSession)
                .where(CrawlSession.id == session_id)
                .values(total_repos=CrawlSession.total_repos + 1)
            )

    async def _link_session_author(self, session: AsyncSession, session_id: int, author_id: int):
        existing = await session.execute(
            select(SessionAuthor).where(
                SessionAuthor.session_id == session_id,
                SessionAuthor.author_id == author_id,
            )
        )
        if existing.scalar_one_or_none() is None:
            session.add(SessionAuthor(session_id=session_id, author_id=author_id))
            await session.execute(
                update(CrawlSession)
                .where(CrawlSession.id == session_id)
                .values(total_authors=CrawlSession.total_authors + 1)
            )

    # ── task dispatcher ───────────────────────────────────

    async def _process(self, session: AsyncSession, task: CrawlTask) -> int:
        logger.info("Processing [%s] %s (session=%d depth=%d)",
                     task.task_type, task.target, task.session_id, task.depth)

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
        return await handler(session, task.session_id, task.target, task.depth)

    # ── search_repos ──────────────────────────────────────

    async def _do_search_repos(
        self, session: AsyncSession, session_id: int,
        query: str, depth: int,
    ) -> int:
        count = 0
        for page in range(1, 4):
            data = await self.client.search_repositories(query, per_page=30, page=page)
            if not data or "items" not in data:
                break
            for item in data["items"]:
                repo = await self._save_repo(session, item)
                if repo:
                    await self._link_session_repo(session, session_id, repo.id)
                    count += 1
                    await self._add_task(
                        session, session_id,
                        "fetch_contributors", item["full_name"],
                        depth=depth + 1,
                        priority=min(item.get("stargazers_count", 0), 10000),
                    )
            if len(data["items"]) < 30:
                break
        await session.commit()
        return count

    # ── fetch_repo ────────────────────────────────────────

    async def _do_fetch_repo(
        self, session: AsyncSession, session_id: int,
        full_name: str, depth: int,
    ) -> int:
        data = await self.client.get_repository(full_name)
        if not data:
            return 0

        repo = await self._save_repo(session, data)
        if not repo:
            return 0

        await self._link_session_repo(session, session_id, repo.id)

        if data.get("owner"):
            author = await self._save_author(session, data["owner"])
            if author:
                await self._link_session_author(session, session_id, author.id)
            await self._add_task(
                session, session_id,
                "fetch_user", data["owner"]["login"],
                depth=depth + 1, priority=100,
            )

        # fork parent
        if data.get("fork") and data.get("parent"):
            parent_data = data["parent"]
            parent_repo = await self._save_repo(session, parent_data)
            if parent_repo:
                repo.fork_source_id = parent_repo.id
                await self._link_session_repo(session, session_id, parent_repo.id)
            await self._add_task(
                session, session_id,
                "fetch_repo", parent_data["full_name"],
                depth=depth + 1, priority=500,
            )

        await self._add_task(
            session, session_id,
            "fetch_contributors", full_name,
            depth=depth + 1,
            priority=min(data.get("stargazers_count", 0), 10000),
        )

        await session.commit()
        return 1

    # ── fetch_user (relaxed filter: stars>50) ─────────────

    async def _do_fetch_user(
        self, session: AsyncSession, session_id: int,
        login: str, depth: int,
    ) -> int:
        data = await self.client.get_user(login)
        if not data:
            return 0

        author = await self._save_author(session, data, detailed=True)
        if author:
            await self._link_session_author(session, session_id, author.id)

        repos_data = await self.client.get_user_repos(login, per_page=30)
        count = 1
        if repos_data and isinstance(repos_data, list):
            for rd in repos_data:
                # relaxed filter: AI-related OR stars > 50
                if self._is_ai_related(rd) or rd.get("stargazers_count", 0) > 50:
                    repo = await self._save_repo(session, rd)
                    if repo:
                        await self._link_session_repo(session, session_id, repo.id)
                        count += 1
                        # expand: fetch contributors for these repos too
                        await self._add_task(
                            session, session_id,
                            "fetch_contributors", rd["full_name"],
                            depth=depth + 1,
                            priority=min(rd.get("stargazers_count", 0), 5000),
                        )

        await session.commit()
        return count

    # ── fetch_contributors ────────────────────────────────

    async def _do_fetch_contributors(
        self, session: AsyncSession, session_id: int,
        full_name: str, depth: int,
    ) -> int:
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

            await self._link_session_author(session, session_id, author.id)

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
                session, session_id,
                "fetch_user", cd["login"],
                depth=depth + 1,
                priority=min(cd.get("contributions", 0), 1000),
            )
            count += 1

        await session.commit()
        return count

    # ── persistence helpers ───────────────────────────────

    async def _save_author(
        self, session: AsyncSession, data: dict, detailed: bool = False,
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
        self, session: AsyncSession, data: dict,
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
        sessions = await self.list_sessions()
        total_repos = sum(s["total_repos"] for s in sessions)
        total_authors = sum(s["total_authors"] for s in sessions)
        tasks_pending = sum(s["tasks_pending"] for s in sessions)
        tasks_done = sum(s["tasks_done"] for s in sessions)
        tasks_errors = sum(s["tasks_errors"] for s in sessions)

        return {
            "worker_running": self.worker_running,
            "sessions": len(sessions),
            "running_sessions": sum(1 for s in sessions if s["status"] == "running"),
            "total_repos": total_repos,
            "total_authors": total_authors,
            "tasks_pending": tasks_pending,
            "tasks_done": tasks_done,
            "tasks_errors": tasks_errors,
            "rate_limit_remaining": self.client.rate_limit_remaining,
            "last_error": self._last_error,
        }
