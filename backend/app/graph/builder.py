from sqlalchemy import select, text, bindparam, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Author, Repository, Topic, RepoTopic, RepoContributor,
    SessionRepository,
)


def _repo_node(repo: Repository, compact: bool = False) -> dict:
    node = {
        "id": f"repo:{repo.id}",
        "type": "repo",
        "label": repo.full_name,
        "val": max(1, (repo.stars or 0) ** 0.5),
        "stars": repo.stars or 0,
    }
    if not compact:
        node.update({
            "language": repo.language,
            "description": repo.description,
            "url": f"https://github.com/{repo.full_name}",
        })
    return node


def _author_node(author: Author, compact: bool = False) -> dict:
    node = {
        "id": f"author:{author.id}",
        "type": "author",
        "label": author.login,
        "val": max(1, (author.followers or 0) ** 0.4),
        "followers": author.followers or 0,
    }
    if not compact:
        node.update({
            "avatar_url": author.avatar_url,
            "url": f"https://github.com/{author.login}",
        })
    return node


def _topic_node(topic: Topic, repo_count: int = 1) -> dict:
    return {
        "id": f"topic:{topic.id}",
        "type": "topic",
        "label": topic.name,
        "val": max(1, repo_count ** 0.6),
        "repo_count": repo_count,
    }


class GraphBuilder:

    @staticmethod
    async def build_graph(
        session: AsyncSession,
        limit: int = 300,
        min_stars: int = 0,
        node_types: list[str] | None = None,
        search: str | None = None,
        session_id: int | None = None,
        language: str | None = None,
        compact: bool = False,
    ) -> dict:
        if node_types is None:
            node_types = ["author", "repo", "topic"]

        nodes: list[dict] = []
        links: list[dict] = []
        node_ids: set[str] = set()
        own_link_keys: set[tuple[str, str]] = set()

        # ── repos ─────────────────────────────────────────
        query = select(Repository).order_by(Repository.stars.desc())
        if min_stars > 0:
            query = query.where(Repository.stars >= min_stars)
        if search:
            pattern = f"%{search}%"
            query = query.where(
                Repository.full_name.ilike(pattern)
                | Repository.description.ilike(pattern)
            )
        if language:
            query = query.where(Repository.language == language)
        if session_id:
            query = query.where(
                Repository.id.in_(
                    select(SessionRepository.repository_id).where(
                        SessionRepository.session_id == session_id
                    )
                )
            )
        query = query.limit(limit)

        repos = (await session.execute(query)).scalars().all()
        repo_ids: set[int] = set()
        owner_ids: set[int] = set()

        if "repo" in node_types:
            for r in repos:
                nodes.append(_repo_node(r, compact))
                node_ids.add(f"repo:{r.id}")
                repo_ids.add(r.id)
                if r.owner_id:
                    owner_ids.add(r.owner_id)

        # ── authors (owners + top contributors) ──────────────
        if "author" in node_types and owner_ids:
            authors = (
                await session.execute(select(Author).where(Author.id.in_(owner_ids)))
            ).scalars().all()

            for a in authors:
                nid = f"author:{a.id}"
                nodes.append(_author_node(a, compact))
                node_ids.add(nid)

            for r in repos:
                if r.owner_id and f"author:{r.owner_id}" in node_ids:
                    src = f"author:{r.owner_id}"
                    tgt = f"repo:{r.id}"
                    links.append({"source": src, "target": tgt, "type": "owns"})
                    own_link_keys.add((src, tgt))

        # ── contributor authors (contributions >= 10) ─────
        contrib_author_ids: set[int] = set()
        if "author" in node_types and repo_ids:
            top_contribs = (
                await session.execute(
                    select(
                        RepoContributor.author_id,
                        func.sum(RepoContributor.contributions).label("total"),
                    )
                    .where(RepoContributor.repository_id.in_(repo_ids))
                    .group_by(RepoContributor.author_id)
                    .having(func.sum(RepoContributor.contributions) >= 10)
                )
            ).all()

            contrib_author_ids = {row.author_id for row in top_contribs} - owner_ids
            if contrib_author_ids:
                contrib_authors = (
                    await session.execute(
                        select(Author).where(Author.id.in_(contrib_author_ids))
                    )
                ).scalars().all()
                for a in contrib_authors:
                    nid = f"author:{a.id}"
                    if nid not in node_ids:
                        nodes.append(_author_node(a, compact))
                        node_ids.add(nid)

        # ── topics ────────────────────────────────────────
        if "topic" in node_types and repo_ids:
            repo_topics = (
                await session.execute(
                    select(RepoTopic).where(RepoTopic.repository_id.in_(repo_ids))
                )
            ).scalars().all()

            topic_ids_needed: set[int] = set()
            topic_repo_count: dict[int, int] = {}
            for rt in repo_topics:
                topic_ids_needed.add(rt.topic_id)
                topic_repo_count[rt.topic_id] = topic_repo_count.get(rt.topic_id, 0) + 1

            if topic_ids_needed:
                topics = (
                    await session.execute(
                        select(Topic).where(Topic.id.in_(topic_ids_needed))
                    )
                ).scalars().all()

                for t in topics:
                    nid = f"topic:{t.id}"
                    nodes.append(_topic_node(t, topic_repo_count.get(t.id, 1)))
                    node_ids.add(nid)

                for rt in repo_topics:
                    src = f"repo:{rt.repository_id}"
                    tgt = f"topic:{rt.topic_id}"
                    if src in node_ids and tgt in node_ids:
                        links.append({"source": src, "target": tgt, "type": "has_topic"})

        # ── contributor edges (with weight) ───────────────
        author_db_ids: list[int] = []
        if "author" in node_types and repo_ids:
            # includes both owners and contributor authors
            author_db_ids = [
                int(nid.split(":")[1]) for nid in node_ids if nid.startswith("author:")
            ]
            if author_db_ids:
                contribs = (
                    await session.execute(
                        select(RepoContributor).where(
                            RepoContributor.repository_id.in_(repo_ids),
                            RepoContributor.author_id.in_(author_db_ids),
                        )
                    )
                ).scalars().all()

                for c in contribs:
                    src = f"author:{c.author_id}"
                    tgt = f"repo:{c.repository_id}"
                    if src in node_ids and tgt in node_ids:
                        if (src, tgt) not in own_link_keys:
                            links.append({
                                "source": src,
                                "target": tgt,
                                "type": "contributes",
                                "weight": min(c.contributions / 100, 3) if c.contributions else 0.5,
                            })

        # ── fork links ────────────────────────────────────
        if "repo" in node_types:
            for r in repos:
                if r.fork_source_id and f"repo:{r.fork_source_id}" in node_ids:
                    links.append({
                        "source": f"repo:{r.id}",
                        "target": f"repo:{r.fork_source_id}",
                        "type": "forked_from",
                    })

        # ── co-worker links (SQL aggregate) ───────────────
        if "author" in node_types and len(author_db_ids) > 1:
            coworker_sql = text("""
                SELECT a1.author_id AS aid1, a2.author_id AS aid2, COUNT(*) AS shared
                FROM repo_contributors a1
                JOIN repo_contributors a2
                  ON a1.repository_id = a2.repository_id AND a1.author_id < a2.author_id
                WHERE a1.author_id IN :ids AND a2.author_id IN :ids
                GROUP BY a1.author_id, a2.author_id
                HAVING COUNT(*) >= 1
                ORDER BY shared DESC
                LIMIT 500
            """).bindparams(bindparam("ids", expanding=True))
            coworker_result = await session.execute(
                coworker_sql, {"ids": author_db_ids}
            )
            for row in coworker_result:
                src = f"author:{row.aid1}"
                tgt = f"author:{row.aid2}"
                if src in node_ids and tgt in node_ids:
                    links.append({
                        "source": src,
                        "target": tgt,
                        "type": "coworker",
                        "weight": min(row.shared / 3, 3),
                    })

        # ── connection count → val boost (log-dampened) ────
        connection_map: dict[str, int] = {}
        for l in links:
            connection_map[l["source"]] = connection_map.get(l["source"], 0) + 1
            connection_map[l["target"]] = connection_map.get(l["target"], 0) + 1

        import math
        for node in nodes:
            cc = connection_map.get(node["id"], 0)
            if cc > 0:
                node["val"] = node["val"] + math.log2(1 + cc) * 0.5
            node["connections"] = cc

        return {
            "nodes": nodes,
            "links": links,
            "stats": {
                "total_nodes": len(nodes),
                "total_links": len(links),
                "repos": sum(1 for n in nodes if n["type"] == "repo"),
                "authors": sum(1 for n in nodes if n["type"] == "author"),
                "topics": sum(1 for n in nodes if n["type"] == "topic"),
            },
        }

    @staticmethod
    async def get_neighbors(
        session: AsyncSession,
        node_id: str,
        depth: int = 1,
    ) -> dict:
        parts = node_id.split(":")
        if len(parts) != 2:
            return {"nodes": [], "links": [], "stats": {}}

        node_type, db_id = parts[0], int(parts[1])
        nodes: list[dict] = []
        links: list[dict] = []
        node_ids: set[str] = set()

        if node_type == "repo":
            repo = (
                await session.execute(select(Repository).where(Repository.id == db_id))
            ).scalar_one_or_none()
            if not repo:
                return {"nodes": [], "links": [], "stats": {}}

            nodes.append(_repo_node(repo))
            node_ids.add(f"repo:{repo.id}")

            if repo.owner_id:
                owner = (
                    await session.execute(select(Author).where(Author.id == repo.owner_id))
                ).scalar_one_or_none()
                if owner:
                    nodes.append(_author_node(owner))
                    node_ids.add(f"author:{owner.id}")
                    links.append({
                        "source": f"author:{owner.id}",
                        "target": f"repo:{repo.id}",
                        "type": "owns",
                    })

            rows = (
                await session.execute(
                    select(RepoTopic, Topic)
                    .join(Topic)
                    .where(RepoTopic.repository_id == repo.id)
                )
            ).all()
            for rt, topic in rows:
                tid = f"topic:{topic.id}"
                if tid not in node_ids:
                    nodes.append(_topic_node(topic))
                    node_ids.add(tid)
                links.append({
                    "source": f"repo:{repo.id}",
                    "target": tid,
                    "type": "has_topic",
                })

            rows = (
                await session.execute(
                    select(RepoContributor, Author)
                    .join(Author, RepoContributor.author_id == Author.id)
                    .where(RepoContributor.repository_id == repo.id)
                )
            ).all()
            for contrib, author in rows:
                aid = f"author:{author.id}"
                if aid not in node_ids:
                    nodes.append(_author_node(author))
                    node_ids.add(aid)
                links.append({
                    "source": aid,
                    "target": f"repo:{repo.id}",
                    "type": "contributes",
                    "weight": min(contrib.contributions / 100, 3) if contrib.contributions else 0.5,
                })

            # fork parent
            if repo.fork_source_id:
                parent = (
                    await session.execute(select(Repository).where(Repository.id == repo.fork_source_id))
                ).scalar_one_or_none()
                if parent:
                    pid = f"repo:{parent.id}"
                    if pid not in node_ids:
                        nodes.append(_repo_node(parent))
                        node_ids.add(pid)
                    links.append({
                        "source": f"repo:{repo.id}",
                        "target": pid,
                        "type": "forked_from",
                    })

        elif node_type == "author":
            author = (
                await session.execute(select(Author).where(Author.id == db_id))
            ).scalar_one_or_none()
            if not author:
                return {"nodes": [], "links": [], "stats": {}}

            nodes.append(_author_node(author))
            node_ids.add(f"author:{author.id}")

            owned = (
                await session.execute(
                    select(Repository)
                    .where(Repository.owner_id == db_id)
                    .order_by(Repository.stars.desc())
                    .limit(20)
                )
            ).scalars().all()
            for r in owned:
                rid = f"repo:{r.id}"
                nodes.append(_repo_node(r))
                node_ids.add(rid)
                links.append({
                    "source": f"author:{author.id}",
                    "target": rid,
                    "type": "owns",
                })

            contributed = (
                await session.execute(
                    select(RepoContributor, Repository)
                    .join(Repository)
                    .where(RepoContributor.author_id == db_id)
                    .order_by(Repository.stars.desc())
                    .limit(20)
                )
            ).all()
            for contrib, r in contributed:
                rid = f"repo:{r.id}"
                if rid not in node_ids:
                    nodes.append(_repo_node(r))
                    node_ids.add(rid)
                links.append({
                    "source": f"author:{author.id}",
                    "target": rid,
                    "type": "contributes",
                    "weight": min(contrib.contributions / 100, 3) if contrib.contributions else 0.5,
                })

            # ── coworker discovery ────────────────────────
            # find authors who contributed to the same repos
            contributed_repo_ids = [
                int(nid.split(":")[1]) for nid in node_ids if nid.startswith("repo:")
            ]
            if contributed_repo_ids:
                coworker_rows = (
                    await session.execute(
                        select(
                            RepoContributor.author_id,
                            func.sum(RepoContributor.contributions).label("total"),
                        )
                        .where(
                            RepoContributor.repository_id.in_(contributed_repo_ids),
                            RepoContributor.author_id != db_id,
                        )
                        .group_by(RepoContributor.author_id)
                        .order_by(func.sum(RepoContributor.contributions).desc())
                        .limit(20)
                    )
                ).all()

                for row in coworker_rows:
                    coworker_id = row.author_id
                    total_contribs = row.total
                    coworker_author = await session.get(Author, coworker_id)
                    if coworker_author:
                        nid = f"author:{coworker_id}"
                        if nid not in node_ids:
                            nodes.append(_author_node(coworker_author, compact=True))
                            node_ids.add(nid)
                        links.append({
                            "source": f"author:{db_id}",
                            "target": nid,
                            "type": "coworker",
                            "weight": min(total_contribs / 50, 3) if total_contribs else 0.5,
                        })

        elif node_type == "topic":
            topic = (
                await session.execute(select(Topic).where(Topic.id == db_id))
            ).scalar_one_or_none()
            if not topic:
                return {"nodes": [], "links": [], "stats": {}}

            nodes.append(_topic_node(topic))
            node_ids.add(f"topic:{topic.id}")

            rows = (
                await session.execute(
                    select(RepoTopic, Repository)
                    .join(Repository)
                    .where(RepoTopic.topic_id == db_id)
                    .order_by(Repository.stars.desc())
                    .limit(50)
                )
            ).all()
            for rt, r in rows:
                rid = f"repo:{r.id}"
                if rid not in node_ids:
                    nodes.append(_repo_node(r))
                    node_ids.add(rid)
                links.append({
                    "source": rid,
                    "target": f"topic:{topic.id}",
                    "type": "has_topic",
                })

        return {
            "nodes": nodes,
            "links": links,
            "stats": {"total_nodes": len(nodes), "total_links": len(links)},
        }
