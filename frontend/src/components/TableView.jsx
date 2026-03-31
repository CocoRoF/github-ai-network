import { useState, useMemo } from "react";

const TABS = [
  { key: "repos", label: "Repositories" },
  { key: "authors", label: "Authors" },
  { key: "topics", label: "Topics" },
  { key: "links", label: "Edges" },
];

function useSorted(items, defaultKey, defaultDir = "desc") {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (typeof av === "string")
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [items, sortKey, sortDir]);

  const toggle = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  };

  return { sorted, sortKey, sortDir, toggle };
}

function TH({ label, field, sortKey, sortDir, onToggle }) {
  const active = sortKey === field;
  return (
    <th className="tv-th" onClick={() => onToggle(field)}>
      {label}
      {active && <span className="sort-arrow">{sortDir === "asc" ? " ▲" : " ▼"}</span>}
    </th>
  );
}

export default function TableView({ graphData, onNodeClick }) {
  const [tab, setTab] = useState("repos");
  const [search, setSearch] = useState("");

  const { repos, authors, topics, linkRows } = useMemo(() => {
    const links = graphData.links || [];
    const nodeMap = {};
    (graphData.nodes || []).forEach((n) => (nodeMap[n.id] = n));

    /* degree */
    const degree = {};
    (graphData.nodes || []).forEach((n) => (degree[n.id] = 0));
    links.forEach((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (degree[s] !== undefined) degree[s]++;
      if (degree[t] !== undefined) degree[t]++;
    });

    const repos = (graphData.nodes || [])
      .filter((n) => n.type === "repo")
      .map((n) => ({ ...n, degree: degree[n.id] || 0, stars: n.stars || 0 }));
    const authors = (graphData.nodes || [])
      .filter((n) => n.type === "author")
      .map((n) => ({ ...n, degree: degree[n.id] || 0, followers: n.followers || 0 }));
    const topics = (graphData.nodes || [])
      .filter((n) => n.type === "topic")
      .map((n) => ({ ...n, degree: degree[n.id] || 0 }));

    const linkRows = links.map((l) => {
      const sId = l.source?.id ?? l.source;
      const tId = l.target?.id ?? l.target;
      return {
        sourceId: sId,
        sourceLabel: nodeMap[sId]?.label || sId,
        targetId: tId,
        targetLabel: nodeMap[tId]?.label || tId,
        type: l.type,
        weight: l.weight || 1,
      };
    });

    return { repos, authors, topics, linkRows };
  }, [graphData]);

  const lowerSearch = search.toLowerCase();
  const filter = (items) =>
    lowerSearch
      ? items.filter(
          (i) =>
            (i.label || "").toLowerCase().includes(lowerSearch) ||
            (i.sourceLabel || "").toLowerCase().includes(lowerSearch) ||
            (i.targetLabel || "").toLowerCase().includes(lowerSearch)
        )
      : items;

  return (
    <div className="table-view">
      <div className="tv-toolbar">
        <div className="tv-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tv-tab${tab === t.key ? " active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="tv-tab-count">
                {t.key === "repos"
                  ? repos.length
                  : t.key === "authors"
                  ? authors.length
                  : t.key === "topics"
                  ? topics.length
                  : linkRows.length}
              </span>
            </button>
          ))}
        </div>
        <input
          className="tv-search"
          type="text"
          placeholder="Filter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="tv-table-wrap">
        {tab === "repos" && (
          <RepoTable rows={filter(repos)} onNodeClick={onNodeClick} />
        )}
        {tab === "authors" && (
          <AuthorTable rows={filter(authors)} onNodeClick={onNodeClick} />
        )}
        {tab === "topics" && (
          <TopicTable rows={filter(topics)} onNodeClick={onNodeClick} />
        )}
        {tab === "links" && <LinkTable rows={filter(linkRows)} />}
      </div>
    </div>
  );
}

function RepoTable({ rows, onNodeClick }) {
  const { sorted, sortKey, sortDir, toggle } = useSorted(rows, "stars");
  return (
    <table className="tv-table">
      <thead>
        <tr>
          <th className="tv-th tv-th-rank">#</th>
          <TH label="Repository" field="label" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <TH label="★ Stars" field="stars" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <TH label="Degree" field="degree" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, i) => (
          <tr key={r.id} className="tv-row clickable" onClick={() => onNodeClick(r)}>
            <td className="tv-td tv-td-rank">{i + 1}</td>
            <td className="tv-td tv-td-name" title={r.label}>{r.label}</td>
            <td className="tv-td tv-td-num">{r.stars.toLocaleString()}</td>
            <td className="tv-td tv-td-num">{r.degree}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuthorTable({ rows, onNodeClick }) {
  const { sorted, sortKey, sortDir, toggle } = useSorted(rows, "followers");
  return (
    <table className="tv-table">
      <thead>
        <tr>
          <th className="tv-th tv-th-rank">#</th>
          <TH label="Author" field="label" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <TH label="Followers" field="followers" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <TH label="Degree" field="degree" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((a, i) => (
          <tr key={a.id} className="tv-row clickable" onClick={() => onNodeClick(a)}>
            <td className="tv-td tv-td-rank">{i + 1}</td>
            <td className="tv-td tv-td-name" title={a.label}>{a.label}</td>
            <td className="tv-td tv-td-num">{a.followers.toLocaleString()}</td>
            <td className="tv-td tv-td-num">{a.degree}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TopicTable({ rows, onNodeClick }) {
  const { sorted, sortKey, sortDir, toggle } = useSorted(rows, "degree");
  return (
    <table className="tv-table">
      <thead>
        <tr>
          <th className="tv-th tv-th-rank">#</th>
          <TH label="Topic" field="label" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <TH label="Degree" field="degree" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((t, i) => (
          <tr key={t.id} className="tv-row clickable" onClick={() => onNodeClick(t)}>
            <td className="tv-td tv-td-rank">{i + 1}</td>
            <td className="tv-td tv-td-name">{t.label}</td>
            <td className="tv-td tv-td-num">{t.degree}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LinkTable({ rows }) {
  const { sorted, sortKey, sortDir, toggle } = useSorted(rows, "weight");
  return (
    <table className="tv-table">
      <thead>
        <tr>
          <th className="tv-th tv-th-rank">#</th>
          <TH label="Source" field="sourceLabel" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <TH label="Target" field="targetLabel" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <TH label="Type" field="type" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <TH label="Weight" field="weight" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((l, i) => (
          <tr key={i} className="tv-row">
            <td className="tv-td tv-td-rank">{i + 1}</td>
            <td className="tv-td tv-td-name" title={l.sourceLabel}>{l.sourceLabel}</td>
            <td className="tv-td tv-td-name" title={l.targetLabel}>{l.targetLabel}</td>
            <td className="tv-td tv-td-type">
              <span className={`type-badge type-${l.type === "owns" ? "author" : l.type === "has_topic" ? "topic" : "repo"}`}>
                {l.type}
              </span>
            </td>
            <td className="tv-td tv-td-num">{l.weight}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
