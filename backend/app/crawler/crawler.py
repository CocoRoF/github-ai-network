import asyncio
import json
import logging
import time
from collections import deque
from datetime import datetime, timezone

from sqlalchemy import select, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory
from app.models import (
    Author, Repository, Topic, RepoTopic, RepoContributor,
    CrawlTask, CrawlSession, SessionRepository, SessionAuthor,
    CrawlLog,
)
from app.crawler.github_client import GitHubClient
from app.crawler.seeds import AI_TOPICS, AI_KEYWORDS

logger = logging.getLogger(__name__)


class CrawlerManager:
    """Manages multiple crawl sessions with concurrent workers."""

    MAX_LOG_BUFFER = 200  # keep last N log entries in memory for fast access
    NUM_WORKERS = 3       # concurrent worker count

    def __init__(self):
        self.client = GitHubClient()
        self._workers: list[asyncio.Task] = []
        self._worker_sem = asyncio.Semaphore(self.NUM_WORKERS)
        self._last_error: str | None = None
        self._invalidate_cache_fn = None  # set by main.py
        # ── in-memory lookup caches (github_id → db_id) ──
        self._author_cache: dict[int, int] = {}   # github_id → db primary key
        self._topic_cache: dict[str, int] = {}     # topic_name → db primary key
        # ── observability state ───────────────────────
        self._heartbeat_at: float = 0.0           # last worker activity (time.time())
        self._started_at: float | None = None      # worker start time
        self._current_task: dict | None = None     # {id, type, target, session_id, started_at}
        self._active_tasks: dict[int, dict] = {}   # worker_idx → current task info
        self._tasks_completed_times: deque = deque(maxlen=60)  # timestamps of last 60 completions
        self._log_buffer: deque = deque(maxlen=self.MAX_LOG_BUFFER)

        # wire up GitHubClient callbacks
        self.client._on_rate_limit_wait = self._on_rate_limit_wait
        self.client._on_rate_limit_resume = self._on_rate_limit_resume
        self.client._on_api_error = self._on_api_error

    @property
    def worker_running(self) -> bool:
        return any(not w.done() for w in self._workers)

    @property
    def tasks_per_minute(self) -> float:
        now = time.time()
        cutoff = now - 300  # 5-minute window
        recent = [t for t in self._tasks_completed_times if t > cutoff]
        if len(recent) < 2:
            return 0.0
        span = now - recent[0]
        return (len(recent) / span) * 60.0 if span > 0 else 0.0

    # ── event logging ─────────────────────────────────────

    async def _log_event(
        self, event_type: str, message: str,
        level: str = "info", session_id: int | None = None,
        metadata: dict | None = None,
    ):
        """Write an event to DB and in-memory buffer."""
        entry = {
            "session_id": session_id,
            "level": level,
            "event_type": event_type,
            "message": message,
            "metadata": metadata,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self._log_buffer.append(entry)

        try:
            async with async_session_factory() as session:
                session.add(CrawlLog(
                    session_id=session_id,
                    level=level,
                    event_type=event_type,
                    message=message,
                    metadata_json=json.dumps(metadata) if metadata else None,
                ))
                await session.commit()
        except Exception as exc:
            logger.error("Failed to write crawl log: %s", exc)

    async def _on_rate_limit_wait(self, remaining: int, wait_secs: float):
        await self._log_event(
            "rate_limit_wait",
            f"Rate limit: {remaining} remaining, waiting {wait_secs:.0f}s",
            level="warning",
            session_id=self._current_task["session_id"] if self._current_task else None,
            metadata={"remaining": remaining, "wait_seconds": round(wait_secs)},
        )

    async def _on_rate_limit_resume(self):
        await self._log_event(
            "rate_limit_resume",
            "Rate limit wait ended, resuming",
            level="info",
            session_id=self._current_task["session_id"] if self._current_task else None,
        )

    async def _on_api_error(self, url: str, status_code: int, detail: str):
        await self._log_event(
            "api_error",
            f"API error {status_code} on {url}: {detail[:200]}",
            level="error",
            session_id=self._current_task["session_id"] if self._current_task else None,
            metadata={"url": url, "status_code": status_code},
        )

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

        await self._log_event(
            "session_start", f"Session created and started: {name}",
            session_id=cs.id,
            metadata={"seed_type": seed_type, "seed_value": seed_value},
        )
        self._ensure_worker()
        return cs

    async def start_session(self, session_id: int):
        async with async_session_factory() as session:
            cs = await session.get(CrawlSession, session_id)
            if cs:
                cs.status = "running"
                cs.paused_at = None
                await session.commit()
        await self._log_event(
            "session_resume", "Session resumed",
            session_id=session_id,
        )
        self._ensure_worker()

    async def pause_session(self, session_id: int):
        async with async_session_factory() as session:
            cs = await session.get(CrawlSession, session_id)
            if cs:
                cs.status = "paused"
                cs.paused_at = datetime.now(timezone.utc)
                await session.commit()
        await self._log_event(
            "session_pause", "Session paused",
            session_id=session_id,
        )

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
        # Remove finished workers
        self._workers = [w for w in self._workers if not w.done()]
        if not self._workers:
            self._started_at = time.time()
            self._heartbeat_at = time.time()
            for i in range(self.NUM_WORKERS):
                w = asyncio.create_task(self._run(worker_idx=i))
                w.add_done_callback(self._on_worker_done)
                self._workers.append(w)
            logger.info("Started %d workers", self.NUM_WORKERS)
            asyncio.create_task(self._log_event(
                "worker_start", f"Started {self.NUM_WORKERS} concurrent workers",
            ))

    def _on_worker_done(self, task: asyncio.Task):
        # Check if ALL workers are done
        if all(w.done() for w in self._workers):
            self._current_task = None
            self._started_at = None
            self._active_tasks.clear()
        if task.cancelled():
            logger.info("A worker was cancelled")
        elif task.exception():
            exc = task.exception()
            self._last_error = f"Worker crashed: {exc}"
            logger.error("Worker crashed: %s", exc, exc_info=exc)
            try:
                asyncio.get_event_loop().create_task(
                    self._log_event("worker_crash", f"Worker crashed: {exc}", level="error")
                )
            except RuntimeError:
                pass
        else:
            if all(w.done() for w in self._workers):
                logger.info("All workers finished (no more tasks)")
                try:
                    asyncio.get_event_loop().create_task(
                        self._log_event("worker_stop", "All workers finished — no more tasks")
                    )
                except RuntimeError:
                    pass

    async def stop_worker(self):
        for w in self._workers:
            w.cancel()
        for w in self._workers:
            try:
                await w
            except asyncio.CancelledError:
                pass
        self._workers.clear()
        self._active_tasks.clear()
        logger.info("All workers stopped")

    async def close(self):
        await self.stop_worker()
        await self.client.close()

    # ── main worker loop ──────────────────────────────────

    async def _run(self, worker_idx: int = 0):
        while True:
            self._heartbeat_at = time.time()
            try:
                async with async_session_factory() as session:
                    task = await self._next_task(session)
                    if task is None:
                        self._active_tasks.pop(worker_idx, None)
                        self._current_task = None
                        # check if any sessions are still running
                        running = (await session.execute(
                            select(func.count(CrawlSession.id)).where(
                                CrawlSession.status == "running"
                            )
                        )).scalar() or 0
                        if running == 0:
                            logger.info("Worker-%d: no running sessions — exiting", worker_idx)
                            return
                        logger.debug("Worker-%d: no pending tasks — sleeping 15s", worker_idx)
                        await asyncio.sleep(15)
                        continue

                    session_id = task.session_id
                    task_start = time.time()
                    task_info = {
                        "id": task.id,
                        "type": task.task_type,
                        "target": task.target,
                        "session_id": session_id,
                        "started_at": datetime.now(timezone.utc).isoformat(),
                    }
                    self._active_tasks[worker_idx] = task_info
                    self._current_task = task_info

                    await self._log_event(
                        "task_start",
                        f"[{task.task_type}] {task.target}",
                        session_id=session_id,
                        metadata={"task_id": task.id, "depth": task.depth},
                    )

                    try:
                        count = await self._process(session, task)
                        task.status = "done"
                        task.result_count = count
                        duration = round(time.time() - task_start, 2)
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
                            "Task %d [%s] session=%d done — %d items (%.1fs)",
                            task.id, task.task_type, session_id, count, duration,
                        )
                        self._tasks_completed_times.append(time.time())

                        await self._log_event(
                            "task_done",
                            f"[{task.task_type}] {task.target} → {count} items ({duration}s)",
                            session_id=session_id,
                            metadata={"task_id": task.id, "result_count": count, "duration": duration},
                        )
                    except Exception as exc:
                        task.retry_count = (task.retry_count or 0) + 1
                        if task.retry_count < (task.max_retries or 3):
                            # retriable: reset to pending with lowered priority
                            task.status = "pending"
                            task.priority = max(0, task.priority - 100)
                            task.error_message = f"Retry {task.retry_count}: {str(exc)[:300]}"
                            duration = round(time.time() - task_start, 2)
                            # tasks_pending stays the same (task goes back to queue)
                            logger.warning(
                                "Task %d [%s] retry %d/%d: %s",
                                task.id, task.task_type, task.retry_count,
                                task.max_retries or 3, exc,
                            )
                            await self._log_event(
                                "task_retry",
                                f"[{task.task_type}] {task.target}: retry {task.retry_count} — {str(exc)[:200]}",
                                level="warning",
                                session_id=session_id,
                                metadata={"task_id": task.id, "retry": task.retry_count, "duration": duration},
                            )
                        else:
                            # max retries exceeded: permanent failure
                            task.status = "error"
                            task.error_message = str(exc)[:500]
                            duration = round(time.time() - task_start, 2)
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
                                "Task %d [%s] error (max retries): %s",
                                task.id, task.task_type, exc, exc_info=True,
                            )
                            await self._log_event(
                                "task_error",
                                f"[{task.task_type}] {task.target}: {str(exc)[:300]}",
                                level="error",
                                session_id=session_id,
                                metadata={"task_id": task.id, "error": str(exc)[:500], "duration": duration},
                            )

                    task.processed_at = datetime.now(timezone.utc)
                    self._active_tasks.pop(worker_idx, None)
                    self._current_task = None
                    await session.commit()

                    if self._invalidate_cache_fn:
                        self._invalidate_cache_fn()

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_error = f"Worker-{worker_idx} loop error: {exc}"
                self._active_tasks.pop(worker_idx, None)
                self._current_task = None
                logger.error("Worker-%d loop error: %s", worker_idx, exc, exc_info=True)
                await self._log_event(
                    "worker_crash", f"Worker-{worker_idx} loop error: {exc}",
                    level="error",
                )
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

    # ── fetch_user ─────────────────────────────────────────

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

        count = 1
        for page in range(1, 4):  # max 3 pages (90 repos)
            repos_data = await self.client.get_user_repos(login, per_page=30, page=page)
            if not repos_data or not isinstance(repos_data, list):
                break
            for rd in repos_data:
                repo = await self._save_repo(session, rd)
                if repo:
                    await self._link_session_repo(session, session_id, repo.id)
                    count += 1
                    await self._add_task(
                        session, session_id,
                        "fetch_contributors", rd["full_name"],
                        depth=depth + 1,
                        priority=min(rd.get("stargazers_count", 0), 5000),
                    )
            if len(repos_data) < 30:
                break

        await session.commit()
        return count

    # ── fetch_contributors ────────────────────────────────

    async def _do_fetch_contributors(
        self, session: AsyncSession, session_id: int,
        full_name: str, depth: int,
    ) -> int:
        result = await session.execute(
            select(Repository).where(Repository.full_name == full_name)
        )
        repo = result.scalar_one_or_none()
        if not repo:
            return 0

        count = 0
        for page in range(1, 3):  # max 2 pages (60 contributors)
            data = await self.client.get_repo_contributors(full_name, per_page=30, page=page)
            if not data or not isinstance(data, list):
                break

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

            if len(data) < 30:
                break  # no more pages

        await session.commit()
        return count

    # ── persistence helpers ───────────────────────────────

    async def _save_author(
        self, session: AsyncSession, data: dict, detailed: bool = False,
    ) -> Author | None:
        if not data or "id" not in data:
            return None

        github_id = data["id"]

        # fast path: return cached author if not requesting detailed update
        if github_id in self._author_cache and not detailed:
            cached_id = self._author_cache[github_id]
            author = await session.get(Author, cached_id)
            if author:
                return author

        result = await session.execute(
            select(Author).where(Author.github_id == github_id)
        )
        author = result.scalar_one_or_none()

        if author is None:
            author = Author(
                github_id=github_id,
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
        self._author_cache[github_id] = author.id
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
            if topic_name in self._topic_cache:
                topic_id = self._topic_cache[topic_name]
                topic = await session.get(Topic, topic_id)
                if topic is None:
                    # cache stale — fall through to DB lookup
                    del self._topic_cache[topic_name]

            if topic_name not in self._topic_cache:
                t_result = await session.execute(
                    select(Topic).where(Topic.name == topic_name)
                )
                topic = t_result.scalar_one_or_none()
                if topic is None:
                    topic = Topic(name=topic_name)
                    session.add(topic)
                    await session.flush()
                self._topic_cache[topic_name] = topic.id

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
        return False

    # ── status ────────────────────────────────────────────

    async def get_status(self) -> dict:
        sessions = await self.list_sessions()
        total_repos = sum(s["total_repos"] for s in sessions)
        total_authors = sum(s["total_authors"] for s in sessions)
        tasks_pending = sum(s["tasks_pending"] for s in sessions)
        tasks_done = sum(s["tasks_done"] for s in sessions)
        tasks_errors = sum(s["tasks_errors"] for s in sessions)

        now = time.time()
        heartbeat_ago = round(now - self._heartbeat_at, 1) if self._heartbeat_at else None
        uptime = round(now - self._started_at, 1) if self._started_at else None

        return {
            "worker_running": self.worker_running,
            "worker_healthy": self.worker_running and (heartbeat_ago is not None and heartbeat_ago < 60),
            "heartbeat_seconds_ago": heartbeat_ago,
            "worker_uptime_seconds": uptime,
            "num_workers": self.NUM_WORKERS,
            "active_workers": sum(1 for w in self._workers if not w.done()),
            "current_task": self._current_task,
            "active_tasks": list(self._active_tasks.values()),
            "tasks_per_minute": round(self.tasks_per_minute, 2),
            "sessions": len(sessions),
            "running_sessions": sum(1 for s in sessions if s["status"] == "running"),
            "total_repos": total_repos,
            "total_authors": total_authors,
            "tasks_pending": tasks_pending,
            "tasks_done": tasks_done,
            "tasks_errors": tasks_errors,
            "rate_limit_remaining": self.client.rate_limit_remaining,
            "rate_limit_limit": self.client.rate_limit_limit,
            "rate_limit_reset": self.client.rate_limit_reset_dt.isoformat() if self.client.rate_limit_reset_dt else None,
            "rate_limit_waiting": self.client.rate_limit_waiting,
            "total_api_calls": self.client.total_api_calls,
            "last_error": self._last_error,
        }

    # ── auto-resume on startup ────────────────────────────

    async def auto_resume(self):
        """Check for sessions that were 'running' before shutdown and resume the worker."""
        async with async_session_factory() as session:
            running = (await session.execute(
                select(func.count(CrawlSession.id)).where(
                    CrawlSession.status == "running"
                )
            )).scalar() or 0

            # also check for stale 'processing' tasks → reset to 'pending'
            stale = (await session.execute(
                select(CrawlTask).where(CrawlTask.status == "processing")
            )).scalars().all()
            for t in stale:
                t.status = "pending"
                logger.info("Reset stale processing task %d to pending", t.id)
            if stale:
                await session.commit()

        if running > 0:
            logger.info("Auto-resuming: %d running sessions found", running)
            await self._log_event(
                "worker_start",
                f"Auto-resume: {running} running session(s) found after restart",
                metadata={"running_sessions": running, "stale_tasks_reset": len(stale)},
            )
            self._ensure_worker()
        else:
            logger.info("No running sessions to auto-resume")

    # ── log retrieval ─────────────────────────────────────

    async def get_logs(
        self, session_id: int | None = None,
        level: str | None = None,
        limit: int = 100, offset: int = 0,
    ) -> list[dict]:
        async with async_session_factory() as db:
            q = select(CrawlLog)
            if session_id is not None:
                q = q.where(CrawlLog.session_id == session_id)
            if level:
                q = q.where(CrawlLog.level == level)
            q = q.order_by(CrawlLog.created_at.desc()).limit(limit).offset(offset)
            result = await db.execute(q)
            return [
                {
                    "id": log.id,
                    "session_id": log.session_id,
                    "level": log.level,
                    "event_type": log.event_type,
                    "message": log.message,
                    "metadata": json.loads(log.metadata_json) if log.metadata_json else None,
                    "created_at": log.created_at.isoformat() if log.created_at else None,
                }
                for log in result.scalars().all()
            ]

    def get_recent_logs(self, limit: int = 50) -> list[dict]:
        """Get recent logs from in-memory buffer (fast, no DB hit)."""
        items = list(self._log_buffer)
        items.reverse()
        return items[:limit]
