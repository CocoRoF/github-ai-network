from datetime import datetime, timezone
from sqlalchemy import (
    Column, Integer, String, Text, Boolean, DateTime,
    ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.orm import relationship
from app.database import Base


def utcnow():
    return datetime.now(timezone.utc)


# ── Crawl Session ─────────────────────────────────────────

class CrawlSession(Base):
    __tablename__ = "crawl_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    seed_type = Column(String(50), nullable=False)      # search_query | repository | user
    seed_value = Column(String(512), nullable=False)
    status = Column(String(20), default="running")       # running | paused | completed | error
    # counter cache fields
    total_repos = Column(Integer, default=0)
    total_authors = Column(Integer, default=0)
    tasks_pending = Column(Integer, default=0)
    tasks_done = Column(Integer, default=0)
    tasks_errors = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    paused_at = Column(DateTime(timezone=True), nullable=True)

    tasks = relationship("CrawlTask", back_populates="session", cascade="all, delete-orphan")


# ── Author ────────────────────────────────────────────────

class Author(Base):
    __tablename__ = "authors"

    id = Column(Integer, primary_key=True, autoincrement=True)
    github_id = Column(Integer, unique=True, nullable=False, index=True)
    login = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=True)
    avatar_url = Column(String(512), nullable=True)
    bio = Column(Text, nullable=True)
    company = Column(String(255), nullable=True)
    location = Column(String(255), nullable=True)
    followers = Column(Integer, default=0)
    following = Column(Integer, default=0)
    public_repos = Column(Integer, default=0)
    user_type = Column(String(50), default="User")
    crawled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)

    repositories = relationship("Repository", back_populates="owner")


# ── Repository ────────────────────────────────────────────

class Repository(Base):
    __tablename__ = "repositories"
    __table_args__ = (
        Index("ix_repos_stars", "stars"),
        Index("ix_repos_owner_stars", "owner_id", "stars"),
        Index("ix_repos_language", "language"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    github_id = Column(Integer, unique=True, nullable=False, index=True)
    full_name = Column(String(512), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    owner_id = Column(Integer, ForeignKey("authors.id"), nullable=True)
    stars = Column(Integer, default=0)
    forks_count = Column(Integer, default=0)
    watchers = Column(Integer, default=0)
    open_issues = Column(Integer, default=0)
    language = Column(String(100), nullable=True)
    license_name = Column(String(100), nullable=True)
    is_fork = Column(Boolean, default=False)
    fork_source_id = Column(Integer, ForeignKey("repositories.id"), nullable=True)
    homepage = Column(String(512), nullable=True)
    default_branch = Column(String(100), default="main")
    repo_created_at = Column(DateTime(timezone=True), nullable=True)
    repo_updated_at = Column(DateTime(timezone=True), nullable=True)
    crawled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)

    owner = relationship("Author", back_populates="repositories")
    topics = relationship("RepoTopic", back_populates="repository")
    contributors = relationship("RepoContributor", back_populates="repository")


# ── Topic ─────────────────────────────────────────────────

class Topic(Base):
    __tablename__ = "topics"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)

    repositories = relationship("RepoTopic", back_populates="topic")


# ── RepoTopic ────────────────────────────────────────────

class RepoTopic(Base):
    __tablename__ = "repo_topics"
    __table_args__ = (
        UniqueConstraint("repository_id", "topic_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    repository_id = Column(Integer, ForeignKey("repositories.id"), nullable=False)
    topic_id = Column(Integer, ForeignKey("topics.id"), nullable=False)

    repository = relationship("Repository", back_populates="topics")
    topic = relationship("Topic", back_populates="repositories")


# ── RepoContributor ──────────────────────────────────────

class RepoContributor(Base):
    __tablename__ = "repo_contributors"
    __table_args__ = (
        UniqueConstraint("repository_id", "author_id"),
        Index("ix_contrib_author", "author_id"),
        Index("ix_contrib_repo", "repository_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    repository_id = Column(Integer, ForeignKey("repositories.id"), nullable=False)
    author_id = Column(Integer, ForeignKey("authors.id"), nullable=False)
    contributions = Column(Integer, default=0)

    repository = relationship("Repository", back_populates="contributors")
    author = relationship("Author")


# ── Session ↔ Repository / Author junction tables ────────

class SessionRepository(Base):
    __tablename__ = "session_repositories"
    __table_args__ = (
        UniqueConstraint("session_id", "repository_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(Integer, ForeignKey("crawl_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    repository_id = Column(Integer, ForeignKey("repositories.id"), nullable=False, index=True)


class SessionAuthor(Base):
    __tablename__ = "session_authors"
    __table_args__ = (
        UniqueConstraint("session_id", "author_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(Integer, ForeignKey("crawl_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id = Column(Integer, ForeignKey("authors.id"), nullable=False, index=True)


# ── CrawlTask ────────────────────────────────────────────

class CrawlTask(Base):
    __tablename__ = "crawl_tasks"
    __table_args__ = (
        UniqueConstraint("session_id", "task_type", "target"),
        Index("ix_crawl_tasks_status_priority", "status", "priority"),
        Index("ix_tasks_session_status", "session_id", "status"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(Integer, ForeignKey("crawl_sessions.id", ondelete="CASCADE"), nullable=False)
    task_type = Column(String(50), nullable=False)
    target = Column(String(512), nullable=False)
    depth = Column(Integer, default=0)
    priority = Column(Integer, default=0)
    status = Column(String(20), default="pending")
    result_count = Column(Integer, default=0)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    processed_at = Column(DateTime(timezone=True), nullable=True)

    session = relationship("CrawlSession", back_populates="tasks")
