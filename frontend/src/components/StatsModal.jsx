import { useState, useMemo } from "react";

/* ── helpers ────────────────────────────────────────── */
function computeAnalytics(graphData) {
  const { nodes, links } = graphData;
  if (!nodes.length) return null;

  /* degree map */
  const degree = {};
  nodes.forEach((n) => (degree[n.id] = 0));
  links.forEach((l) => {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    if (degree[s] !== undefined) degree[s]++;
    if (degree[t] !== undefined) degree[t]++;
  });

  /* split by type */
  const repos = nodes.filter((n) => n.type === "repo");
  const authors = nodes.filter((n) => n.type === "author");
  const topics = nodes.filter((n) => n.type === "topic");

  /* link type breakdown */
  const linkTypes = {};
  links.forEach((l) => {
    linkTypes[l.type] = (linkTypes[l.type] || 0) + 1;
  });

  /* degree stats */
  const degrees = Object.values(degree);
  const totalDegree = degrees.reduce((a, b) => a + b, 0);
  const avgDegree = nodes.length ? totalDegree / nodes.length : 0;
  const maxDeg = Math.max(...degrees, 0);
  const density =
    nodes.length > 1
      ? (2 * links.length) / (nodes.length * (nodes.length - 1))
      : 0;

  /* top by degree */
  const byDegree = [...nodes]
    .map((n) => ({ ...n, degree: degree[n.id] || 0 }))
    .sort((a, b) => b.degree - a.degree);

  /* top repos by stars */
  const reposByStars = [...repos]
    .sort((a, b) => (b.stars || b.val || 0) - (a.stars || a.val || 0));

  /* hub authors: count how many repos they connect to */
  const authorRepoCount = {};
  authors.forEach((a) => (authorRepoCount[a.id] = 0));
  links.forEach((l) => {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    if (
      (l.type === "owns" || l.type === "contributes") &&
      authorRepoCount[s] !== undefined
    )
      authorRepoCount[s]++;
    if (
      (l.type === "owns" || l.type === "contributes") &&
      authorRepoCount[t] !== undefined
    )
      authorRepoCount[t]++;
  });
  const hubAuthors = [...authors]
    .map((a) => ({
      ...a,
      repoLinks: authorRepoCount[a.id] || 0,
      degree: degree[a.id] || 0,
    }))
    .sort((a, b) => b.repoLinks - a.repoLinks || b.degree - a.degree);

  /* top topics by repo count */
  const topicRepoCount = {};
  topics.forEach((t) => (topicRepoCount[t.id] = 0));
  links.forEach((l) => {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    if (l.type === "has_topic") {
      if (topicRepoCount[t] !== undefined) topicRepoCount[t]++;
      if (topicRepoCount[s] !== undefined) topicRepoCount[s]++;
    }
  });
  const topTopics = [...topics]
    .map((t) => ({ ...t, linkedRepos: topicRepoCount[t.id] || 0 }))
    .sort((a, b) => b.linkedRepos - a.linkedRepos);

  return {
    nodeCount: nodes.length,
    linkCount: links.length,
    repoCount: repos.length,
    authorCount: authors.length,
    topicCount: topics.length,
    linkTypes,
    avgDegree,
    maxDegree: maxDeg,
    density,
    byDegree,
    reposByStars,
    hubAuthors,
    topTopics,
  };
}

/* ── tabs ───────────────────────────────────────────── */
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "repos", label: "Repos" },
  { key: "authors", label: "Authors" },
  { key: "topics", label: "Topics" },
  { key: "central", label: "Centrality" },
];

/* ── component ──────────────────────────────────────── */
export default function StatsModal({ graphData, onClose, onNodeClick }) {
  const [tab, setTab] = useState("overview");
  const analytics = useMemo(() => computeAnalytics(graphData), [graphData]);

  if (!analytics) return null;

  const handleClick = (node) => {
    if (onNodeClick) onNodeClick(node);
  };

  return (
    <div className="stats-modal-overlay" onClick={onClose}>
      <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="stats-modal-header">
          <h2>Graph Analysis</h2>
          <button className="stats-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="stats-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`stats-tab${tab === t.key ? " active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="stats-modal-body">
          {tab === "overview" && <OverviewTab a={analytics} />}
          {tab === "repos" && (
            <ReposTab a={analytics} onNodeClick={handleClick} />
          )}
          {tab === "authors" && (
            <AuthorsTab a={analytics} onNodeClick={handleClick} />
          )}
          {tab === "topics" && (
            <TopicsTab a={analytics} onNodeClick={handleClick} />
          )}
          {tab === "central" && (
            <CentralityTab a={analytics} onNodeClick={handleClick} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Overview ───────────────────────────────────────── */
function OverviewTab({ a }) {
  return (
    <div className="stats-overview">
      <div className="stats-kpi-grid">
        <div className="stats-kpi">
          <span className="stats-kpi-value">{a.nodeCount}</span>
          <span className="stats-kpi-label">Nodes</span>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-value">{a.linkCount}</span>
          <span className="stats-kpi-label">Edges</span>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-value">{a.avgDegree.toFixed(1)}</span>
          <span className="stats-kpi-label">Avg Degree</span>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-value">{a.maxDegree}</span>
          <span className="stats-kpi-label">Max Degree</span>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-value">
            {(a.density * 100).toFixed(3)}%
          </span>
          <span className="stats-kpi-label">Density</span>
        </div>
      </div>

      <h4>Node Distribution</h4>
      <div className="stats-bar-chart">
        <Bar label="Repos" value={a.repoCount} total={a.nodeCount} color="#3fb950" />
        <Bar label="Authors" value={a.authorCount} total={a.nodeCount} color="#58a6ff" />
        <Bar label="Topics" value={a.topicCount} total={a.nodeCount} color="#d29922" />
      </div>

      <h4>Edge Distribution</h4>
      <div className="stats-bar-chart">
        {Object.entries(a.linkTypes)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => (
            <Bar
              key={type}
              label={type}
              value={count}
              total={a.linkCount}
              color="#8b949e"
            />
          ))}
      </div>
    </div>
  );
}

function Bar({ label, value, total, color }) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div className="stats-bar-row">
      <span className="stats-bar-label">{label}</span>
      <div className="stats-bar-track">
        <div
          className="stats-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="stats-bar-value">
        {value} ({pct.toFixed(1)}%)
      </span>
    </div>
  );
}

/* ── Repos Tab ──────────────────────────────────────── */
function ReposTab({ a, onNodeClick }) {
  return (
    <div className="stats-list">
      <div className="stats-list-header">
        <span className="stats-col-rank">#</span>
        <span className="stats-col-name">Repository</span>
        <span className="stats-col-num">★ Stars</span>
        <span className="stats-col-num">Degree</span>
      </div>
      {a.reposByStars.slice(0, 100).map((r, i) => (
        <div
          key={r.id}
          className="stats-list-row clickable"
          onClick={() => onNodeClick(r)}
        >
          <span className="stats-col-rank">{i + 1}</span>
          <span className="stats-col-name" title={r.label}>
            {r.label}
          </span>
          <span className="stats-col-num">
            {(r.stars || 0).toLocaleString()}
          </span>
          <span className="stats-col-num">
            {a.byDegree.find((n) => n.id === r.id)?.degree || 0}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Authors Tab ────────────────────────────────────── */
function AuthorsTab({ a, onNodeClick }) {
  return (
    <div className="stats-list">
      <div className="stats-list-header">
        <span className="stats-col-rank">#</span>
        <span className="stats-col-name">Author</span>
        <span className="stats-col-num">Repos</span>
        <span className="stats-col-num">Degree</span>
      </div>
      {a.hubAuthors.slice(0, 100).map((au, i) => (
        <div
          key={au.id}
          className="stats-list-row clickable"
          onClick={() => onNodeClick(au)}
        >
          <span className="stats-col-rank">{i + 1}</span>
          <span className="stats-col-name" title={au.label}>
            {au.label}
          </span>
          <span className="stats-col-num">{au.repoLinks}</span>
          <span className="stats-col-num">{au.degree}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Topics Tab ─────────────────────────────────────── */
function TopicsTab({ a, onNodeClick }) {
  return (
    <div className="stats-list">
      <div className="stats-list-header">
        <span className="stats-col-rank">#</span>
        <span className="stats-col-name">Topic</span>
        <span className="stats-col-num">Repos</span>
      </div>
      {a.topTopics.slice(0, 100).map((t, i) => (
        <div
          key={t.id}
          className="stats-list-row clickable"
          onClick={() => onNodeClick(t)}
        >
          <span className="stats-col-rank">{i + 1}</span>
          <span className="stats-col-name">{t.label}</span>
          <span className="stats-col-num">{t.linkedRepos}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Centrality Tab ─────────────────────────────────── */
function CentralityTab({ a, onNodeClick }) {
  return (
    <div className="stats-list">
      <div className="stats-list-header">
        <span className="stats-col-rank">#</span>
        <span className="stats-col-type">Type</span>
        <span className="stats-col-name">Node</span>
        <span className="stats-col-num">Degree</span>
      </div>
      {a.byDegree.slice(0, 100).map((n, i) => (
        <div
          key={n.id}
          className="stats-list-row clickable"
          onClick={() => onNodeClick(n)}
        >
          <span className="stats-col-rank">{i + 1}</span>
          <span className={`stats-col-type type-badge type-${n.type}`}>
            {n.type}
          </span>
          <span className="stats-col-name" title={n.label}>
            {n.label}
          </span>
          <span className="stats-col-num">{n.degree}</span>
        </div>
      ))}
    </div>
  );
}
