import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
} from "d3-force-3d";

/* ── constants ──────────────────────────────────────── */
const NODE_COLORS = {
  author: "#58a6ff",
  repo: "#3fb950",
  topic: "#d29922",
};
const LINK_COLORS = {
  owns: "#58a6ff",
  contributes: "#8b949e",
  has_topic: "#d29922",
  coworker: "#da70d6",
  forked_from: "#8888cc",
};
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
  if (node.type === "author") return `https://github.com/${node.id}`;
  if (node.type === "repo") return `https://github.com/${node.id}`;
  if (node.type === "topic") return `https://github.com/topics/${node.id}`;
  return null;
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
            {type === "repo" && n.val > 1 && (
              <span className="nd-conn-stars">
                ★ {Number(n.val).toLocaleString()}
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

/* ── main component ─────────────────────────────────── */
export default function NodeDetailModal({
  node,
  graphData,
  adjacencyMap,
  onClose,
  onNodeNavigate,
}) {
  const canvasRef = useRef(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const simNodesRef = useRef([]);

  const subgraph = useMemo(
    () => buildSubgraph(node.id, graphData, adjacencyMap, 3),
    [node.id, graphData, adjacencyMap]
  );

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

  /* ── 2D force-directed mini graph on Canvas ───────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || subgraph.nodes.length === 0) return;

    const container = canvas.parentElement;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // Simulation nodes
    const simNodes = subgraph.nodes.map((n) => {
      const hop = subgraph.hops.get(n.id) ?? 3;
      return {
        id: n.id,
        label: n.label || n.id,
        type: n.type,
        val: n.val || 1,
        hop,
        x: (Math.random() - 0.5) * width * 0.3,
        y: (Math.random() - 0.5) * height * 0.3,
      };
    });

    // Fix center node at origin
    const centerNode = simNodes.find((n) => n.id === node.id);
    if (centerNode) {
      centerNode.fx = 0;
      centerNode.fy = 0;
    }
    simNodesRef.current = simNodes;

    const simLinks = subgraph.links.map((l) => ({
      source: l.source?.id ?? l.source,
      target: l.target?.id ?? l.target,
      type: l.type,
    }));

    const nc = simNodes.length;
    const sim = forceSimulation(simNodes, 2)
      .force(
        "charge",
        forceManyBody()
          .strength(nc > 200 ? -40 : nc > 80 ? -70 : -120)
          .distanceMax(nc > 200 ? 200 : 300)
      )
      .force(
        "link",
        forceLink(simLinks)
          .id((d) => d.id)
          .distance(nc > 200 ? 25 : nc > 80 ? 40 : 60)
          .strength(0.3)
      )
      .force("center", forceCenter())
      .alphaDecay(0.04)
      .velocityDecay(0.4);

    let animFrame;

    function render() {
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(width / 2, height / 2);

      // ── Edges ──
      for (const link of simLinks) {
        const s = link.source;
        const t = link.target;
        if (typeof s !== "object" || typeof t !== "object") continue;
        const maxHop = Math.max(s.hop ?? 3, t.hop ?? 3);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.strokeStyle = LINK_COLORS[link.type] || "#8b949e";
        ctx.globalAlpha = maxHop <= 1 ? 0.4 : maxHop <= 2 ? 0.18 : 0.07;
        ctx.lineWidth = maxHop <= 1 ? 1.5 : 1;
        ctx.stroke();
      }

      // ── Nodes ──
      for (const n of simNodes) {
        const isCenter = n.id === node.id;
        const baseR = Math.max(3, 3 + (Math.log(n.val + 1) / Math.log(100)) * 6);
        const radius = isCenter ? 14 : Math.max(3, baseR - n.hop * 0.8);
        const alpha =
          n.hop === 0 ? 1 : n.hop === 1 ? 0.9 : n.hop === 2 ? 0.55 : 0.3;

        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = NODE_COLORS[n.type] || "#8b949e";
        ctx.fill();

        if (isCenter) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2.5;
          ctx.stroke();
          // Glow
          ctx.save();
          ctx.shadowColor = NODE_COLORS[n.type] || "#ffffff";
          ctx.shadowBlur = 15;
          ctx.beginPath();
          ctx.arc(n.x, n.y, radius + 3, 0, Math.PI * 2);
          ctx.strokeStyle = NODE_COLORS[n.type] || "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.6;
          ctx.stroke();
          ctx.restore();
        }

        n._radius = radius;
      }

      // ── Labels (hop 0–1, or high-val hop 2) ──
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      for (const n of simNodes) {
        if (n.hop > 1 && n.val < 50) continue;
        const isCenter = n.id === node.id;
        const fontSize = isCenter ? 13 : n.hop <= 1 ? 11 : 9;
        ctx.font = `bold ${fontSize}px -apple-system, "Segoe UI", sans-serif`;
        ctx.globalAlpha = isCenter ? 1 : n.hop <= 1 ? 0.8 : 0.4;
        const label = getLabelText(n);
        const yOff = (n._radius || 5) + 4;
        // Shadow
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.fillText(label, n.x + 1, n.y - yOff + 1);
        // Text
        ctx.fillStyle = isCenter
          ? "#ffffff"
          : NODE_COLORS[n.type] || "#cccccc";
        ctx.fillText(label, n.x, n.y - yOff);
      }

      ctx.restore();
    }

    sim.on("tick", () => {
      cancelAnimationFrame(animFrame);
      animFrame = requestAnimationFrame(render);
    });

    return () => {
      sim.stop();
      cancelAnimationFrame(animFrame);
    };
  }, [subgraph, node.id]);

  /* ── Canvas mouse interaction ─────────────────────── */
  const hitTest = useCallback(
    (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      for (const n of simNodesRef.current) {
        const dx = n.x - mx;
        const dy = n.y - my;
        const r = (n._radius || 5) + 5;
        if (dx * dx + dy * dy < r * r) return n;
      }
      return null;
    },
    []
  );

  const handleCanvasMove = useCallback(
    (e) => setHoveredNode(hitTest(e)),
    [hitTest]
  );

  const handleCanvasClick = useCallback(
    (e) => {
      const hit = hitTest(e);
      if (hit && hit.id !== node.id) onNodeNavigate(hit);
    },
    [hitTest, node.id, onNodeNavigate]
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
            <div className="nd-section">
              <h3>Overview</h3>
              {node.description && (
                <p className="nd-description">{node.description}</p>
              )}
              <div className="nd-meta-grid">
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
                {node.type === "repo" && node.language && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Language</span>
                    <span className="nd-meta-value">{node.language}</span>
                  </div>
                )}
                {node.type === "author" && node.followers != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Followers</span>
                    <span className="nd-meta-value">
                      {Number(node.followers).toLocaleString()}
                    </span>
                  </div>
                )}
                {node.type === "author" && node.public_repos != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Repos</span>
                    <span className="nd-meta-value">{node.public_repos}</span>
                  </div>
                )}
                {node.val != null && (
                  <div className="nd-meta-item">
                    <span className="nd-meta-label">Weight</span>
                    <span className="nd-meta-value">{node.val}</span>
                  </div>
                )}
              </div>
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

          {/* Right: mini graph */}
          <div className="nd-graph">
            <div className="nd-graph-header">
              <span>3-hop Neighborhood</span>
              <span className="nd-graph-stats">
                {subStats.total} nodes · {subStats.edges} edges
              </span>
            </div>
            <div className="nd-graph-canvas-wrap">
              <canvas
                ref={canvasRef}
                onMouseMove={handleCanvasMove}
                onClick={handleCanvasClick}
                style={{ cursor: hoveredNode ? "pointer" : "default" }}
              />
              {hoveredNode && (
                <div className="nd-graph-tooltip">
                  <span
                    className={`nd-type-badge nd-type-${hoveredNode.type}`}
                  >
                    {hoveredNode.type}
                  </span>
                  <span>{hoveredNode.label || hoveredNode.id}</span>
                  {hoveredNode.val > 1 && (
                    <span className="nd-tooltip-val">
                      ({hoveredNode.val})
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
