import { useEffect, useRef, useMemo, useState, useCallback, lazy, Suspense } from "react";

const GraphView3DLarge = lazy(() => import("./GraphView3DLarge"));

/* ── constants ──────────────────────────────────────── */
const MAX_SUBGRAPH = 250;

/* ── helpers ────────────────────────────────────────── */
function getLabelText(node) {
  const label = node.label || node.id || "";
  if (node.type === "repo" && label.includes("/")) return label.split("/").pop();
  return label.length > 25 ? label.substring(0, 22) + "…" : label;
}

function buildSubgraph(nodeId, graphData, adjacencyMap, maxHops = 3) {
  const visited = new Map();
  visited.set(nodeId, 0);
  const queue = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift();
    const dist = visited.get(current);
    if (dist >= maxHops) continue;
    for (const nb of adjacencyMap.get(current) || []) {
      if (!visited.has(nb)) {
        visited.set(nb, dist + 1);
        queue.push(nb);
      }
    }
  }

  // Budget: keep all hop 0–1, top by val for hop 2+
  if (visited.size > MAX_SUBGRAPH) {
    const nodeMap = new Map();
    for (const n of graphData.nodes) {
      if (visited.has(n.id)) nodeMap.set(n.id, n);
    }
    const kept = new Map();
    for (const [id, hop] of visited) {
      if (hop <= 1) kept.set(id, hop);
    }
    const rest = [];
    for (const [id, hop] of visited) {
      if (hop > 1) rest.push({ id, hop, val: nodeMap.get(id)?.val || 0 });
    }
    rest.sort((a, b) => b.val - a.val);
    const budget = MAX_SUBGRAPH - kept.size;
    for (let i = 0; i < Math.min(budget, rest.length); i++) {
      kept.set(rest[i].id, rest[i].hop);
    }
    visited.clear();
    for (const [id, hop] of kept) visited.set(id, hop);
  }

  const subNodes = graphData.nodes.filter((n) => visited.has(n.id));
  const subLinks = graphData.links.filter((l) => {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    return visited.has(s) && visited.has(t);
  });

  return { nodes: subNodes, links: subLinks, hops: visited };
}

function getDirectConnections(nodeId, subgraph) {
  const result = { authors: [], repos: [], topics: [] };
  const seen = new Set();

  for (const link of subgraph.links) {
    const s = link.source?.id ?? link.source;
    const t = link.target?.id ?? link.target;
    const otherId = s === nodeId ? t : t === nodeId ? s : null;
    if (!otherId || seen.has(otherId)) continue;
    seen.add(otherId);

    if (subgraph.hops.get(otherId) !== 1) continue;
    const other = subgraph.nodes.find((n) => n.id === otherId);
    if (!other) continue;

    if (other.type === "author") result.authors.push(other);
    else if (other.type === "repo") result.repos.push(other);
    else if (other.type === "topic") result.topics.push(other);
  }

  result.repos.sort((a, b) => (b.val || 0) - (a.val || 0));
  result.authors.sort((a, b) => (a.label || "").localeCompare(b.label || ""));
  result.topics.sort((a, b) => (a.label || "").localeCompare(b.label || ""));
  return result;
}

function getGitHubUrl(node) {
  if (node.url) return node.url;
  if (node.type === "author") return `https://github.com/${node.label || node.id}`;
  if (node.type === "repo") return `https://github.com/${node.label || node.id}`;
  if (node.type === "topic") return `https://github.com/topics/${node.label || node.id}`;
  return null;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return null;
  }
}

/* ── connection group sub-component ─────────────────── */
function ConnectionGroup({ title, type, nodes, onNodeClick }) {
  const [expanded, setExpanded] = useState(nodes.length <= 8);
  const shown = expanded ? nodes : nodes.slice(0, 5);

  return (
    <div className="nd-conn-group">
      <div className="nd-conn-title" onClick={() => setExpanded((v) => !v)}>
        <span className={`nd-conn-dot nd-dot-${type}`} />
        {title}
        <span className="nd-conn-count">{nodes.length}</span>
        <span className="nd-conn-chevron">{expanded ? "▾" : "▸"}</span>
      </div>
      <div className="nd-conn-list">
        {shown.map((n) => (
          <div
            key={n.id}
            className="nd-conn-item"
            onClick={() => onNodeClick(n)}
          >
            <span className="nd-conn-label">{getLabelText(n)}</span>
            {type === "repo" && n.stars != null && (
              <span className="nd-conn-stars">
                ★ {Number(n.stars).toLocaleString()}
              </span>
            )}
          </div>
        ))}
        {!expanded && nodes.length > 5 && (
          <div className="nd-conn-more" onClick={() => setExpanded(true)}>
            +{nodes.length - 5} more
          </div>
        )}
      </div>
    </div>
  );
}

/* ── graph style for modal mini-graph ─────────────── */
const MODAL_GRAPH_STYLE = {
  nodeMinSize: 1,
  nodeMaxSize: 12,
  labelScale: 1.0,
  labelThreshold: 0.8,
  showLabels: true,
  edgeOpacity: 0.18,
  edgeWidthScale: 1.0,
  bloomStrength: 0.5,
  bloomRadius: 0.08,
  bloomThreshold: 0.1,
  particleSpeed: 0.004,
  particleCount: 1,
  showParticles: false,
  autoOrbit: false,
  starField: true,
  fogDensity: 0.0004,
  alphaDecay: 0.08, // Fast settling for modal subgraph
};

/* ── main component ─────────────────────────────────── */
export default function NodeDetailModal({
  node,
  graphData,
  adjacencyMap,
  onClose,
  onNodeNavigate,
}) {
  const miniGraphRef = useRef();

  const modalGraphStyle = useMemo(
    () => ({ ...MODAL_GRAPH_STYLE, centerNodeId: node.id }),
    [node.id]
  );

  const subgraph = useMemo(
    () => buildSubgraph(node.id, graphData, adjacencyMap, 3),
    [node.id, graphData, adjacencyMap]
  );

  // Build subgraph data with raw source/target ids (not d3 objects)
  const subgraphData = useMemo(() => ({
    nodes: subgraph.nodes.map((n) => ({ ...n })),
    links: subgraph.links.map((l) => ({
      ...l,
      source: l.source?.id ?? l.source,
      target: l.target?.id ?? l.target,
    })),
  }), [subgraph]);

  const connections = useMemo(
    () => getDirectConnections(node.id, subgraph),
    [node.id, subgraph]
  );

  const subStats = useMemo(() => {
    const byType = { author: 0, repo: 0, topic: 0 };
    for (const n of subgraph.nodes)
      byType[n.type] = (byType[n.type] || 0) + 1;
    return {
      total: subgraph.nodes.length,
      edges: subgraph.links.length,
      byType,
    };
  }, [subgraph]);

  // Escape — capture phase so it fires before GraphView3DLarge's handler
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  // Handle click on mini-graph node
  const handleMiniGraphClick = useCallback(
    (clickedNode) => {
      if (clickedNode && clickedNode.id !== node.id) {
        onNodeNavigate(clickedNode);
      }
    },
    [node.id, onNodeNavigate]
  );

  // Selected node for highlighting in mini graph
  const selectedNodeForMini = useMemo(
    () => subgraph.nodes.find((n) => n.id === node.id) || node,
    [subgraph.nodes, node]
  );

  /* ── Render ───────────────────────────────────────── */
  const nodeLabel = node.label || node.id;
  const ghUrl = getGitHubUrl(node);
  const totalConns =
    connections.authors.length +
    connections.repos.length +
    connections.topics.length;

  return (
    <div className="nd-overlay" onClick={onClose}>
      <div className="nd-modal" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="nd-header">
          <div className="nd-title">
            <span className={`nd-type-badge nd-type-${node.type}`}>
              {node.type}
            </span>
            <h2>{nodeLabel}</h2>
          </div>
          <button className="nd-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* ── Body ── */}
        <div className="nd-body">
          {/* Left: info */}
          <div className="nd-info">
            {/* Author avatar & identity */}
            {node.type === "author" && (
              <div className="nd-section nd-author-header">
                {node.avatar_url && (
                  <img
                    src={node.avatar_url}
                    alt={nodeLabel}
                    className="nd-avatar"
                  />
                )}
                <div className="nd-author-identity">
                  {node.name && <div className="nd-author-name">{node.name}</div>}
                  {node.bio && <p className="nd-author-bio">{node.bio}</p>}
                  <div className="nd-author-details">
                    {node.company && (
                      <span className="nd-author-detail">
                        <span className="nd-detail-icon">🏢</span> {node.company}
                      </span>
                    )}
                    {node.location && (
                      <span className="nd-author-detail">
                        <span className="nd-detail-icon">📍</span> {node.location}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="nd-section">
              <h3>Overview</h3>
              {node.description && (
                <p className="nd-description">{node.description}</p>
              )}
              <div className="nd-meta-grid">
                {/* Repo metadata */}
                {node.type === "repo" && node.stars != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Stars</span>
                    <span className="nd-meta-value">
                      ★ {Number(node.stars).toLocaleString()}
                    </span>
                  </div>
                )}
                {node.type === "repo" && node.forks != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Forks</span>
                    <span className="nd-meta-value">
                      ⑂ {Number(node.forks).toLocaleString()}
                    </span>
                  </div>
                )}
                {node.type === "repo" && node.watchers != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Watchers</span>
                    <span className="nd-meta-value">
                      👁 {Number(node.watchers).toLocaleString()}
                    </span>
                  </div>
                )}
                {node.type === "repo" && node.open_issues != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Open Issues</span>
                    <span className="nd-meta-value">
                      {Number(node.open_issues).toLocaleString()}
                    </span>
                  </div>
                )}
                {node.type === "repo" && node.language && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Language</span>
                    <span className="nd-meta-value">{node.language}</span>
                  </div>
                )}
                {node.type === "repo" && node.license && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">License</span>
                    <span className="nd-meta-value">{node.license}</span>
                  </div>
                )}
                {node.type === "repo" && node.is_fork && (
                  <div className="nd-meta-item nd-meta-fork">
                    <span className="nd-meta-label">Fork</span>
                    <span className="nd-meta-value">Yes</span>
                  </div>
                )}
                {node.type === "repo" && node.repo_created_at && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Created</span>
                    <span className="nd-meta-value">
                      {formatDate(node.repo_created_at)}
                    </span>
                  </div>
                )}
                {node.type === "repo" && node.repo_updated_at && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Last Updated</span>
                    <span className="nd-meta-value">
                      {formatDate(node.repo_updated_at)}
                    </span>
                  </div>
                )}

                {/* Author metadata */}
                {node.type === "author" && node.followers != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Followers</span>
                    <span className="nd-meta-value">
                      {Number(node.followers).toLocaleString()}
                    </span>
                  </div>
                )}
                {node.type === "author" && node.following != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Following</span>
                    <span className="nd-meta-value">
                      {Number(node.following).toLocaleString()}
                    </span>
                  </div>
                )}
                {node.type === "author" && node.public_repos != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Public Repos</span>
                    <span className="nd-meta-value">{node.public_repos}</span>
                  </div>
                )}

                {/* Topic metadata */}
                {node.type === "topic" && node.repo_count != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Repositories</span>
                    <span className="nd-meta-value">
                      {Number(node.repo_count).toLocaleString()}
                    </span>
                  </div>
                )}

                {/* Common */}
                {node.val != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Weight</span>
                    <span className="nd-meta-value">{node.val}</span>
                  </div>
                )}
              </div>

              {/* Homepage link for repos */}
              {node.type === "repo" && node.homepage && (
                <a
                  href={node.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="nd-homepage-link"
                >
                  🌐 {node.homepage}
                </a>
              )}

              {ghUrl && (
                <a
                  href={ghUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="nd-github-link"
                >
                  Open on GitHub ↗
                </a>
              )}
            </div>

            {/* Connections */}
            <div className="nd-section">
              <h3>
                Direct Connections
                <span className="nd-badge">{totalConns}</span>
              </h3>
              {connections.authors.length > 0 && (
                <ConnectionGroup
                  title="Authors"
                  type="author"
                  nodes={connections.authors}
                  onNodeClick={onNodeNavigate}
                />
              )}
              {connections.repos.length > 0 && (
                <ConnectionGroup
                  title="Repositories"
                  type="repo"
                  nodes={connections.repos}
                  onNodeClick={onNodeNavigate}
                />
              )}
              {connections.topics.length > 0 && (
                <ConnectionGroup
                  title="Topics"
                  type="topic"
                  nodes={connections.topics}
                  onNodeClick={onNodeNavigate}
                />
              )}
              {totalConns === 0 && (
                <p className="nd-empty">No direct connections found</p>
              )}
            </div>

            {/* Neighborhood summary */}
            <div className="nd-section nd-section-footer">
              <div className="nd-neighborhood-stats">
                <span>
                  {subStats.byType.repo} repos · {subStats.byType.author}{" "}
                  authors · {subStats.byType.topic} topics
                </span>
                <span className="nd-neighborhood-sub">
                  {subStats.edges} edges in 3-hop neighborhood
                </span>
              </div>
            </div>
          </div>

          {/* Right: 3D mini graph */}
          <div className="nd-graph">
            <div className="nd-graph-header">
              <span>3-hop Neighborhood</span>
              <span className="nd-graph-stats">
                {subStats.total} nodes · {subStats.edges} edges
              </span>
            </div>
            <div className="nd-graph-canvas-wrap">
              <Suspense
                fallback={
                  <div className="nd-graph-loading">Loading 3D…</div>
                }
              >
                <GraphView3DLarge
                  graphData={subgraphData}
                  onNodeClick={handleMiniGraphClick}
                  onNodeDoubleClick={handleMiniGraphClick}
                  selectedNode={selectedNodeForMini}
                  graphRef={miniGraphRef}
                  graphStyle={modalGraphStyle}
                />
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
