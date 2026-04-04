import { useEffect, useRef, useMemo, useState, useCallback, lazy, Suspense } from "react";

const GraphView3DLarge = lazy(() => import("./GraphView3DLarge"));

const API = "/api";
const MAX_SUBGRAPH = 250;

/* ── helpers ────────────────────────────────────────── */
function getLabelText(node) {
  const label = node.label || node.id || "";
  if (node.type === "repo" && label.includes("/")) return label.split("/").pop();
  return label.length > 25 ? label.substring(0, 22) + "…" : label;
}

function getFullLabel(node) {
  return node.label || node.id || "";
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
  result.repos.sort((a, b) => (b.stars || b.val || 0) - (a.stars || a.val || 0));
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
  } catch { return null; }
}

/* ── Rich Connection Card ─────────────────────────── */
function ConnectionCard({ node, onClick }) {
  if (node.type === "author") {
    return (
      <div className="nd-rich-card" onClick={() => onClick(node)}>
        {node.avatar_url && <img src={node.avatar_url} alt="" className="nd-rich-avatar" />}
        <div className="nd-rich-info">
          <div className="nd-rich-name">{node.label}</div>
          {node.name && <div className="nd-rich-sub">{node.name}</div>}
          <div className="nd-rich-meta">
            {node.followers != null && <span>{Number(node.followers).toLocaleString()} followers</span>}
          </div>
        </div>
      </div>
    );
  }
  if (node.type === "repo") {
    return (
      <div className="nd-rich-card" onClick={() => onClick(node)}>
        <div className="nd-rich-info">
          <div className="nd-rich-name">{getFullLabel(node)}</div>
          {node.description && (
            <div className="nd-rich-desc">{node.description.length > 80 ? node.description.slice(0, 80) + "…" : node.description}</div>
          )}
          <div className="nd-rich-meta">
            {node.stars != null && <span>★ {Number(node.stars).toLocaleString()}</span>}
            {node.language && <span>{node.language}</span>}
          </div>
        </div>
      </div>
    );
  }
  // topic
  return (
    <div className="nd-rich-card" onClick={() => onClick(node)}>
      <div className="nd-rich-info">
        <div className="nd-rich-name">{node.label}</div>
        <div className="nd-rich-meta">
          {node.repo_count != null && <span>{node.repo_count} repos</span>}
        </div>
      </div>
    </div>
  );
}

/* ── Connection Group (rich cards) ────────────────── */
function ConnectionGroup({ title, type, nodes, onNodeClick }) {
  const [expanded, setExpanded] = useState(nodes.length <= 5);
  const shown = expanded ? nodes : nodes.slice(0, 3);

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
          <ConnectionCard key={n.id} node={n} onClick={onNodeClick} />
        ))}
        {!expanded && nodes.length > 3 && (
          <div className="nd-conn-more" onClick={() => setExpanded(true)}>
            +{nodes.length - 3} more
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Enriched Section: Contributors ───────────────── */
function ContributorsSection({ contributors, onNavigate }) {
  const [expanded, setExpanded] = useState(false);
  if (!contributors || contributors.length === 0) return null;
  const shown = expanded ? contributors : contributors.slice(0, 5);
  return (
    <div className="nd-section">
      <h3>Top Contributors <span className="nd-badge">{contributors.length}</span></h3>
      <div className="nd-contrib-list">
        {shown.map((c) => (
          <div key={c.id} className="nd-contrib-item" onClick={() => onNavigate({ id: c.id, type: "author", label: c.login })}>
            {c.avatar_url && <img src={c.avatar_url} alt="" className="nd-contrib-avatar" />}
            <span className="nd-contrib-name">{c.login}</span>
            {c.name && <span className="nd-contrib-realname">{c.name}</span>}
            <span className="nd-contrib-count">{c.contributions.toLocaleString()} commits</span>
          </div>
        ))}
      </div>
      {!expanded && contributors.length > 5 && (
        <div className="nd-conn-more" onClick={() => setExpanded(true)}>+{contributors.length - 5} more</div>
      )}
    </div>
  );
}

/* ── Enriched Section: Owner Info ─────────────────── */
function OwnerSection({ owner, ownerRepos, onNavigate }) {
  if (!owner) return null;
  return (
    <div className="nd-section">
      <h3>Owner</h3>
      <div className="nd-owner-card" onClick={() => onNavigate({ id: owner.id, type: "author", label: owner.login })}>
        {owner.avatar_url && <img src={owner.avatar_url} alt="" className="nd-owner-avatar" />}
        <div className="nd-owner-info">
          <div className="nd-owner-name">{owner.login}</div>
          {owner.name && <div className="nd-owner-realname">{owner.name}</div>}
          {owner.bio && <div className="nd-owner-bio">{owner.bio.length > 100 ? owner.bio.slice(0, 100) + "…" : owner.bio}</div>}
          <div className="nd-rich-meta">
            <span>{(owner.followers || 0).toLocaleString()} followers</span>
            <span>{owner.public_repos || 0} repos</span>
          </div>
        </div>
      </div>
      {ownerRepos && ownerRepos.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>More from {owner.login} <span className="nd-badge">{ownerRepos.length}</span></h3>
          <div className="nd-conn-list">
            {ownerRepos.slice(0, 5).map((r) => (
              <ConnectionCard key={r.id} node={{ ...r, type: "repo" }} onClick={onNavigate} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Enriched Section: Author's Repos ─────────────── */
function AuthorReposSection({ title, repos, onNavigate }) {
  const [expanded, setExpanded] = useState(false);
  if (!repos || repos.length === 0) return null;
  const shown = expanded ? repos : repos.slice(0, 5);
  return (
    <div className="nd-section">
      <h3>{title} <span className="nd-badge">{repos.length}</span></h3>
      <div className="nd-conn-list">
        {shown.map((r) => (
          <ConnectionCard key={r.id} node={{ ...r, type: "repo" }} onClick={onNavigate} />
        ))}
      </div>
      {!expanded && repos.length > 5 && (
        <div className="nd-conn-more" onClick={() => setExpanded(true)}>+{repos.length - 5} more</div>
      )}
    </div>
  );
}

/* ── Enriched Section: Topic's Top Repos ──────────── */
function TopicReposSection({ repos, onNavigate }) {
  if (!repos || repos.length === 0) return null;
  return (
    <div className="nd-section">
      <h3>Top Repositories <span className="nd-badge">{repos.length}</span></h3>
      <div className="nd-conn-list">
        {repos.map((r) => (
          <ConnectionCard key={r.id} node={{ ...r, type: "repo" }} onClick={onNavigate} />
        ))}
      </div>
    </div>
  );
}

/* ── Graph style for modal mini-graph ─────────────── */
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
  alphaDecay: 0.08,
};

/* ══════════════════════════════════════════════════════
   MAIN COMPONENT
   ══════════════════════════════════════════════════════ */
export default function NodeDetailModal({
  node: initialNode,
  graphData,
  adjacencyMap,
  onClose,
  onNodeNavigate,
}) {
  const miniGraphRef = useRef();

  /* ── Navigation Stack ─────────────────────────────── */
  const [navStack, setNavStack] = useState([]);    // history behind current
  const [navForward, setNavForward] = useState([]); // forward stack
  const [currentNode, setCurrentNode] = useState(initialNode);
  const [loading, setLoading] = useState(false);

  // Fetch enriched node detail from API
  const fetchNodeDetail = useCallback(async (targetNode) => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/graph/node/${encodeURIComponent(targetNode.id)}`);
      const detail = await r.json();
      // Merge: keep graph-level fields (val, x, y, z) + overlay API detail
      const graphNode = graphData.nodes.find((n) => n.id === targetNode.id);
      setCurrentNode({ ...(graphNode || targetNode), ...detail });
    } catch (_) {
      setCurrentNode(targetNode);
    }
    setLoading(false);
  }, [graphData.nodes]);

  // Navigate to a new node within the modal
  const navigateTo = useCallback((targetNode) => {
    setNavStack((prev) => [...prev, currentNode]);
    setNavForward([]);
    fetchNodeDetail(targetNode);
  }, [currentNode, fetchNodeDetail]);

  const goBack = useCallback(() => {
    if (navStack.length === 0) return;
    const prev = navStack[navStack.length - 1];
    setNavStack((s) => s.slice(0, -1));
    setNavForward((f) => [currentNode, ...f]);
    setCurrentNode(prev);
  }, [navStack, currentNode]);

  const goForward = useCallback(() => {
    if (navForward.length === 0) return;
    const next = navForward[0];
    setNavForward((f) => f.slice(1));
    setNavStack((s) => [...s, currentNode]);
    setCurrentNode(next);
  }, [navForward, currentNode]);

  /* ── Computed data from current node ─────────────── */
  const node = currentNode;

  const modalGraphStyle = useMemo(
    () => ({ ...MODAL_GRAPH_STYLE, centerNodeId: node.id }),
    [node.id]
  );

  const subgraph = useMemo(
    () => buildSubgraph(node.id, graphData, adjacencyMap, 3),
    [node.id, graphData, adjacencyMap]
  );

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
    return { total: subgraph.nodes.length, edges: subgraph.links.length, byType };
  }, [subgraph]);

  /* ── Escape key ─────────────────────────────────── */
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (navStack.length > 0) {
          goBack();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose, navStack.length, goBack]);

  /* ── Mini-graph interaction ─────────────────────── */
  const [miniSelectedNode, setMiniSelectedNode] = useState(null);

  const centerNodeForMini = useMemo(
    () => subgraph.nodes.find((n) => n.id === node.id) || node,
    [subgraph.nodes, node]
  );

  // Reset mini selection when navigating to new node
  useEffect(() => {
    setMiniSelectedNode(null);
  }, [node.id]);

  const handleMiniGraphClick = useCallback((clickedNode) => {
    if (clickedNode) setMiniSelectedNode(clickedNode);
  }, []);

  // Double-click in mini-graph → navigate within modal
  const handleMiniGraphDoubleClick = useCallback((clickedNode) => {
    if (clickedNode && clickedNode.id !== node.id) {
      navigateTo(clickedNode);
    }
  }, [node.id, navigateTo]);

  const selectedNodeForMini = miniSelectedNode || centerNodeForMini;

  /* ── Render ─────────────────────────────────────── */
  const nodeLabel = node.label || node.id;
  const ghUrl = getGitHubUrl(node);
  const totalConns = connections.authors.length + connections.repos.length + connections.topics.length;

  return (
    <div className="nd-overlay" onClick={onClose}>
      <div className="nd-modal" onClick={(e) => e.stopPropagation()}>
        {/* ── Header with navigation ── */}
        <div className="nd-header">
          <div className="nd-nav-group">
            <button
              className="nd-nav-btn"
              onClick={goBack}
              disabled={navStack.length === 0}
              title="Back"
            >◀</button>
            <button
              className="nd-nav-btn"
              onClick={goForward}
              disabled={navForward.length === 0}
              title="Forward"
            >▶</button>
          </div>
          <div className="nd-title">
            <span className={`nd-type-badge nd-type-${node.type}`}>{node.type}</span>
            <h2>{nodeLabel}</h2>
            {loading && <span className="nd-loading-dot" />}
          </div>
          <button className="nd-close" onClick={onClose}>✕</button>
        </div>

        {/* ── Body ── */}
        <div className="nd-body">
          {/* Left: info panel */}
          <div className="nd-info">
            {/* Author avatar & identity */}
            {node.type === "author" && (
              <div className="nd-section nd-author-header">
                {node.avatar_url && <img src={node.avatar_url} alt={nodeLabel} className="nd-avatar" />}
                <div className="nd-author-identity">
                  {node.name && <div className="nd-author-name">{node.name}</div>}
                  {node.bio && <p className="nd-author-bio">{node.bio}</p>}
                  <div className="nd-author-details">
                    {node.company && <span className="nd-author-detail">🏢 {node.company}</span>}
                    {node.location && <span className="nd-author-detail">📍 {node.location}</span>}
                  </div>
                </div>
              </div>
            )}

            {/* Overview */}
            <div className="nd-section">
              <h3>Overview</h3>
              {node.description && <p className="nd-description">{node.description}</p>}
              <div className="nd-meta-grid">
                {node.type === "repo" && node.stars != null && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Stars</span><span className="nd-meta-value">★ {Number(node.stars).toLocaleString()}</span></div>
                )}
                {node.type === "repo" && node.forks != null && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Forks</span><span className="nd-meta-value">⑂ {Number(node.forks).toLocaleString()}</span></div>
                )}
                {node.type === "repo" && node.watchers != null && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Watchers</span><span className="nd-meta-value">{Number(node.watchers).toLocaleString()}</span></div>
                )}
                {node.type === "repo" && node.open_issues != null && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Issues</span><span className="nd-meta-value">{Number(node.open_issues).toLocaleString()}</span></div>
                )}
                {node.type === "repo" && node.language && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Language</span><span className="nd-meta-value">{node.language}</span></div>
                )}
                {node.type === "repo" && node.license && (
                  <div className="nd-meta-item"><span className="nd-meta-label">License</span><span className="nd-meta-value">{node.license}</span></div>
                )}
                {node.type === "repo" && node.repo_created_at && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Created</span><span className="nd-meta-value">{formatDate(node.repo_created_at)}</span></div>
                )}
                {node.type === "repo" && node.repo_updated_at && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Updated</span><span className="nd-meta-value">{formatDate(node.repo_updated_at)}</span></div>
                )}
                {node.type === "author" && node.followers != null && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Followers</span><span className="nd-meta-value">{Number(node.followers).toLocaleString()}</span></div>
                )}
                {node.type === "author" && node.following != null && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Following</span><span className="nd-meta-value">{Number(node.following).toLocaleString()}</span></div>
                )}
                {node.type === "author" && node.public_repos != null && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Repos</span><span className="nd-meta-value">{node.public_repos}</span></div>
                )}
                {node.type === "topic" && node.repo_count != null && (
                  <div className="nd-meta-item"><span className="nd-meta-label">Repositories</span><span className="nd-meta-value">{Number(node.repo_count).toLocaleString()}</span></div>
                )}
              </div>
              {node.type === "repo" && node.homepage && (
                <a href={node.homepage} target="_blank" rel="noopener noreferrer" className="nd-homepage-link">
                  🌐 {node.homepage}
                </a>
              )}
              {ghUrl && (
                <a href={ghUrl} target="_blank" rel="noopener noreferrer" className="nd-github-link">
                  Open on GitHub ↗
                </a>
              )}
            </div>

            {/* Enriched: Owner (for repos) */}
            {node.type === "repo" && (
              <OwnerSection owner={node.owner} ownerRepos={node.owner_repos} onNavigate={navigateTo} />
            )}

            {/* Enriched: Contributors (for repos) */}
            {node.type === "repo" && (
              <ContributorsSection contributors={node.contributors} onNavigate={navigateTo} />
            )}

            {/* Enriched: Owned Repos (for authors) */}
            {node.type === "author" && (
              <AuthorReposSection title="Owned Repositories" repos={node.owned_repos} onNavigate={navigateTo} />
            )}

            {/* Enriched: Contributed Repos (for authors) */}
            {node.type === "author" && (
              <AuthorReposSection title="Contributed To" repos={node.contributed_repos} onNavigate={navigateTo} />
            )}

            {/* Enriched: Top Repos (for topics) */}
            {node.type === "topic" && (
              <TopicReposSection repos={node.top_repos} onNavigate={navigateTo} />
            )}

            {/* Direct Connections from graph */}
            <div className="nd-section">
              <h3>Network Connections <span className="nd-badge">{totalConns}</span></h3>
              {connections.authors.length > 0 && (
                <ConnectionGroup title="Authors" type="author" nodes={connections.authors} onNodeClick={navigateTo} />
              )}
              {connections.repos.length > 0 && (
                <ConnectionGroup title="Repositories" type="repo" nodes={connections.repos} onNodeClick={navigateTo} />
              )}
              {connections.topics.length > 0 && (
                <ConnectionGroup title="Topics" type="topic" nodes={connections.topics} onNodeClick={navigateTo} />
              )}
              {totalConns === 0 && <p className="nd-empty">No network connections found</p>}
            </div>

            {/* Neighborhood stats */}
            <div className="nd-section nd-section-footer">
              <div className="nd-neighborhood-stats">
                <span>{subStats.byType.repo} repos · {subStats.byType.author} authors · {subStats.byType.topic} topics</span>
                <span className="nd-neighborhood-sub">{subStats.edges} edges in 3-hop neighborhood</span>
              </div>
            </div>
          </div>

          {/* Right: 3D mini graph */}
          <div className="nd-graph">
            <div className="nd-graph-header">
              <span>3-hop Neighborhood</span>
              <span className="nd-graph-stats">{subStats.total} nodes · {subStats.edges} edges</span>
            </div>
            <div className="nd-graph-canvas-wrap">
              <Suspense fallback={<div className="nd-graph-loading">Loading 3D…</div>}>
                <GraphView3DLarge
                  graphData={subgraphData}
                  onNodeClick={handleMiniGraphClick}
                  onNodeDoubleClick={handleMiniGraphDoubleClick}
                  selectedNode={selectedNodeForMini}
                  graphRef={miniGraphRef}
                  graphStyle={modalGraphStyle}
                />
              </Suspense>
            </div>
            {/* Mini info bar for subgraph selection */}
            {miniSelectedNode && miniSelectedNode.id !== node.id && (
              <div className="nd-mini-info-bar">
                <span className={`nd-type-badge nd-type-${miniSelectedNode.type}`}>{miniSelectedNode.type}</span>
                <span className="nd-mini-info-label">{getFullLabel(miniSelectedNode)}</span>
                {miniSelectedNode.stars != null && <span className="nd-mini-info-stars">★ {Number(miniSelectedNode.stars).toLocaleString()}</span>}
                <button className="nd-mini-info-go" onClick={() => navigateTo(miniSelectedNode)}>
                  Open →
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
