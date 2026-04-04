import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { Link, useSearchParams } from "react-router-dom";
const GraphView3DLarge = lazy(() => import("../components/GraphView3DLarge"));
import TableView from "../components/TableView";
import Sidebar from "../components/Sidebar";
const StatsModal = lazy(() => import("../components/StatsModal"));
const NodeDetailModal = lazy(() => import("../components/NodeDetailModal"));
import ErrorBoundary from "../components/ErrorBoundary";

const API = "/api";

function parseFiltersFromURL(searchParams) {
  const types = searchParams.get("types");
  const minStars = searchParams.get("min_stars");
  const limit = searchParams.get("limit");
  const language = searchParams.get("lang");
  return {
    types: types ? types.split(",") : ["author", "repo", "topic"],
    minStars: minStars ? parseInt(minStars, 10) : 0,
    limit: limit ? parseInt(limit, 10) : 100000,
    language: language || "",
  };
}

export default function GraphPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [selectedNode, setSelectedNode] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [sessions, setSessions] = useState([]);
  const initSession = searchParams.get("session") || null;
  const [selectedSession, setSelectedSession] = useState(initSession);
  const [filters, setFilters] = useState(() => parseFiltersFromURL(searchParams));
  const [crawlerStatus, setCrawlerStatus] = useState({});
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({});
  const [graphStyle, setGraphStyle] = useState({
    nodeMinSize: 1,
    nodeMaxSize: 15,
    labelScale: 1.0,
    labelThreshold: 0.8,
    showLabels: true,
    edgeOpacity: 0.15,
    edgeWidthScale: 1.0,
    bloomStrength: 0.6,
    bloomRadius: 0.1,
    bloomThreshold: 0.1,
    particleSpeed: 0.004,
    particleCount: 1,
    showParticles: true,
    autoOrbit: false,
    starField: true,
    fogDensity: 0.0006,
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [viewMode, setViewMode] = useState("graph");
  const [detailNode, setDetailNode] = useState(null);
  const graphRef = useRef();
  const graphContainerRef = useRef(null);
  const searchTimeout = useRef(null);

  /* ── adjacency map for modal subgraph ────────────── */
  const adjacencyMap = useMemo(() => {
    const adj = new Map();
    graphData.links.forEach((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s).push(t);
      adj.get(t).push(s);
    });
    return adj;
  }, [graphData.links]);

  /* ── fetch sessions ───────────────────────────────── */
  const fetchSessions = useCallback(async () => {
    try {
      const r = await fetch(`${API}/sessions`);
      setSessions(await r.json());
    } catch (_) {}
  }, []);

  /* ── fetch graph ──────────────────────────────────── */
  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({
        limit: filters.limit,
        min_stars: filters.minStars,
        types: filters.types.join(","),
        compact: "true",
      });
      if (selectedSession) p.set("session_id", selectedSession);
      if (filters.language) p.set("language", filters.language);
      const res = await fetch(`${API}/graph?${p}`);
      const data = await res.json();
      setGraphData(data);
      setStats(data.stats || {});
    } catch (e) {
      console.error("fetch graph:", e);
    }
    setLoading(false);
  }, [filters, selectedSession]);

  /* ── sync filters → URL query params ──────────────── */
  useEffect(() => {
    const p = new URLSearchParams();
    if (filters.types.join(",") !== "author,repo,topic") p.set("types", filters.types.join(","));
    if (filters.minStars > 0) p.set("min_stars", filters.minStars);
    if (filters.limit !== 100000) p.set("limit", filters.limit);
    if (filters.language) p.set("lang", filters.language);
    if (selectedSession) p.set("session", selectedSession);
    setSearchParams(p, { replace: true });
  }, [filters, selectedSession, setSearchParams]);

  /* ── crawler status polling ───────────────────────── */
  const fetchCrawler = useCallback(async () => {
    try {
      const r = await fetch(`${API}/crawler/status`);
      setCrawlerStatus(await r.json());
    } catch (_) {}
  }, []);

  useEffect(() => {
    fetchSessions();
    fetchGraph();
  }, [fetchGraph, fetchSessions]);

  useEffect(() => {
    fetchCrawler();
    const interval = crawlerStatus.worker_running ? 15_000 : 60_000;
    const id = setInterval(fetchCrawler, interval);
    return () => clearInterval(id);
  }, [fetchCrawler, crawlerStatus.worker_running]);

  /* ── node interaction ─────────────────────────────── */
  const focusNode = useCallback(
    (node) => {
      if (node && graphRef.current && node.x != null) {
        const nx = node.x || 0, ny = node.y || 0, nz = node.z || 0;
        const dist = Math.hypot(nx, ny, nz);
        if (dist < 1) return; // 미배치 노드 — 카메라 이동 skip
        const distRatio = 1 + 120 / dist;
        graphRef.current.cameraPosition(
          { x: nx * distRatio, y: ny * distRatio, z: nz * distRatio },
          { x: nx, y: ny, z: nz },
          1200
        );
      }
    },
    [graphRef]
  );

  const handleNodeClick = async (node) => {
    if (!node) {
      setSelectedNode(null);
      return;
    }
    // 카메라 이동은 GraphView3DLarge 내부에서 전담
    try {
      const r = await fetch(`${API}/graph/node/${encodeURIComponent(node.id)}`);
      const detail = await r.json();
      setSelectedNode({ ...node, ...detail });
    } catch (_) {
      setSelectedNode(node);
    }
  };

  const handleExpand = async (nodeId) => {
    try {
      const r = await fetch(
        `${API}/graph/neighbors?node_id=${encodeURIComponent(nodeId)}`
      );
      const data = await r.json();
      setGraphData((prev) => {
        const ids = new Set(prev.nodes.map((n) => n.id));
        const linkKeys = new Set(
          prev.links.map(
            (l) =>
              `${l.source?.id ?? l.source}-${l.target?.id ?? l.target}`
          )
        );
        return {
          nodes: [
            ...prev.nodes,
            ...data.nodes.filter((n) => !ids.has(n.id)),
          ],
          links: [
            ...prev.links,
            ...data.links.filter(
              (l) => !linkKeys.has(`${l.source}-${l.target}`)
            ),
          ],
        };
      });
    } catch (e) {
      console.error("expand:", e);
    }
  };

  /* ── search ───────────────────────────────────────── */
  const handleSearchInput = (e) => {
    const q = e.target.value;
    clearTimeout(searchTimeout.current);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimeout.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `${API}/search?q=${encodeURIComponent(q)}`
        );
        const data = await r.json();
        setSearchResults(data.results || []);
      } catch (_) {}
    }, 300);
  };

  const handleResultClick = (result) => {
    setSearchResults([]);
    const node = graphData.nodes.find((n) => n.id === result.id);
    if (node) {
      focusNode(node);
      handleNodeClick(node);
    }
  };

  /* ── help overlay ─────────────────────────────────── */
  const [showHelp, setShowHelp] = useState(() => !localStorage.getItem("help-dismissed"));
  const dismissHelp = () => { setShowHelp(false); localStorage.setItem("help-dismissed", "1"); };

  /* ── screenshot capture ──────────────────────────── */
  const handleScreenshot = useCallback(() => {
    const dataUrl = graphRef.current?.captureScreenshot?.();
    if (!dataUrl) return;
    const link = document.createElement("a");
    link.download = `ai-network-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
  }, []);

  /* ── data export ─────────────────────────────────── */
  const handleExportJSON = useCallback(() => {
    const blob = new Blob([JSON.stringify(graphData, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.download = `ai-network-${Date.now()}.json`;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
  }, [graphData]);

  const handleExportCSV = useCallback(() => {
    const header = "id,type,label,stars,language,followers,connections\n";
    const rows = graphData.nodes.map((n) =>
      [n.id, n.type, `"${(n.label || "").replace(/"/g, '""')}"`, n.stars ?? "", n.language ?? "", n.followers ?? "", n.connections ?? ""].join(",")
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const link = document.createElement("a");
    link.download = `ai-network-${Date.now()}.csv`;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
  }, [graphData]);

  /* ── keyboard shortcuts ──────────────────────────── */
  useEffect(() => {
    const handleKey = (e) => {
      // skip if user is typing in an input
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      switch (e.key) {
        case "F11": {
          e.preventDefault();
          const el = graphContainerRef.current;
          if (!el) break;
          if (document.fullscreenElement) document.exitFullscreen();
          else el.requestFullscreen();
          break;
        }
        case "/":
          e.preventDefault();
          document.querySelector(".search-input")?.focus();
          break;
        case "Home":
          graphRef.current?.zoomToFit(800, 100);
          break;
        case "?":
          setShowHelp((v) => !v);
          break;
        case "Escape":
          if (showHelp) setShowHelp(false);
          break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [showHelp]);

  /* ── double click → detail modal ─────────────────── */
  const handleNodeDoubleClick = useCallback(async (node) => {
    if (!node) return;
    try {
      const r = await fetch(`${API}/graph/node/${encodeURIComponent(node.id)}`);
      const detail = await r.json();
      setDetailNode({ ...node, ...detail });
    } catch (_) {
      setDetailNode(node);
    }
  }, []);

  /* ── render ───────────────────────────────────────── */
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">
            <span className="title-icon">◈</span> GitHub AI Network
          </h1>
          <div className="view-tabs">
            <button
              className={`view-tab${viewMode === "graph" ? " active" : ""}`}
              onClick={() => setViewMode("graph")}
            >
              Graph
            </button>
            <button
              className={`view-tab${viewMode === "table" ? " active" : ""}`}
              onClick={() => setViewMode("table")}
            >
              Table
            </button>
          </div>
          <button
            className="sidebar-toggle-header"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            {sidebarOpen ? "◂ Panel" : "▸ Panel"}
          </button>
        </div>

        <div className="header-center">
          <div className="search-container">
            <input
              type="text"
              placeholder="Search repos, authors, topics…"
              className="search-input"
              onChange={handleSearchInput}
            />
            {searchResults.length > 0 && (
              <div className="search-dropdown">
                {searchResults.map((r) => (
                  <div
                    key={r.id}
                    className="search-result"
                    onClick={() => handleResultClick(r)}
                  >
                    <span className={`type-badge type-${r.type}`}>
                      {r.type}
                    </span>
                    <span className="result-label">{r.label}</span>
                    {r.stars != null && (
                      <span className="result-stars">
                        ★ {r.stars.toLocaleString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="header-right">
          <button
            className="refresh-btn"
            onClick={fetchGraph}
            disabled={loading}
          >
            {loading ? "⟳ Loading…" : "⟳ Refresh"}
          </button>
          <Link to="/admin" className="btn btn-admin-link">
            Admin
          </Link>
        </div>
      </header>

      <main className="app-main">
        <div className={`sidebar-wrapper${sidebarOpen ? "" : " collapsed"}`}>
          <Sidebar
            stats={stats}
            crawlerStatus={crawlerStatus}
            filters={filters}
            onFiltersChange={setFilters}
            selectedNode={selectedNode}
            onExpandNode={handleExpand}
            onRefresh={fetchGraph}
            sessions={sessions}
            selectedSession={selectedSession}
            onSessionChange={setSelectedSession}
            graphStyle={graphStyle}
            onStyleChange={setGraphStyle}
            onStatsClick={() => setShowStatsModal(true)}
          />
        </div>
        <div className="graph-container" ref={graphContainerRef}>
          {loading && graphData.nodes.length === 0 && (
            <div className="graph-loading-skeleton">
              <div className="skeleton-pulse" />
              <div className="skeleton-text">Loading graph data…</div>
              <div className="skeleton-sub">
                {stats.total_nodes ? `${stats.total_nodes.toLocaleString()} nodes` : "Preparing visualization"}
              </div>
            </div>
          )}
          {graphData.nodes.length === 0 && !loading ? (
            <div className="empty-state">
              <div className="empty-icon">◈</div>
              <h2>No Data Yet</h2>
              <p>
                Go to the{" "}
                <Link to="/admin" style={{ color: "var(--blue)" }}>
                  Admin page
                </Link>{" "}
                to create a crawler session.
              </p>
            </div>
          ) : viewMode === "graph" ? (
            <>
              <ErrorBoundary title="3D graph rendering failed">
                <Suspense fallback={<div className="empty-state"><div className="empty-icon">◈</div><h2>Loading 3D Engine…</h2></div>}>
                  <GraphView3DLarge
                    graphData={graphData}
                    onNodeClick={handleNodeClick}
                    onNodeDoubleClick={handleNodeDoubleClick}
                    selectedNode={selectedNode}
                    graphRef={graphRef}
                    graphStyle={graphStyle}
                  />
                </Suspense>
              </ErrorBoundary>
              <div className="graph-controls">
                <button
                  className="graph-ctrl-btn"
                  onClick={() => graphRef.current?.zoomIn()}
                  title="Zoom In"
                >+</button>
                <button
                  className="graph-ctrl-btn"
                  onClick={() => graphRef.current?.zoomOut()}
                  title="Zoom Out"
                >−</button>
                <button
                  className="graph-ctrl-btn"
                  onClick={() => graphRef.current?.zoomToFit(800, 100)}
                  title="Reset View (Home)"
                >⌂</button>
                <button
                  className="graph-ctrl-btn"
                  onClick={() => {
                    const el = graphContainerRef.current;
                    if (!el) return;
                    if (document.fullscreenElement) {
                      document.exitFullscreen();
                    } else {
                      el.requestFullscreen();
                    }
                  }}
                  title="Fullscreen (F11)"
                >⛶</button>
                <div className="graph-ctrl-divider" />
                <button
                  className="graph-ctrl-btn"
                  onClick={handleScreenshot}
                  title="Screenshot"
                >📷</button>
                <button
                  className="graph-ctrl-btn"
                  onClick={handleExportJSON}
                  title="Export JSON"
                >💾</button>
                <button
                  className="graph-ctrl-btn"
                  onClick={handleExportCSV}
                  title="Export CSV"
                >📊</button>
                <div className="graph-ctrl-divider" />
                <button
                  className="graph-ctrl-btn"
                  onClick={() => setShowHelp((v) => !v)}
                  title="Help (?)"
                >?</button>
              </div>
              {showHelp && (
                <div className="help-overlay" onClick={dismissHelp}>
                  <div className="help-card" onClick={(e) => e.stopPropagation()}>
                    <h3>Mouse</h3>
                    <div className="help-grid">
                      <span className="help-key">Left drag</span><span>Rotate</span>
                      <span className="help-key">Right drag</span><span>Pan</span>
                      <span className="help-key">Scroll</span><span>Zoom</span>
                      <span className="help-key">Click</span><span>Select node</span>
                      <span className="help-key">Double-click</span><span>Node details</span>
                      <span className="help-key">Right-click</span><span>Context menu</span>
                    </div>
                    <h3>Fly Controls</h3>
                    <div className="help-grid">
                      <span className="help-key">W / &#x2191;</span><span>Forward</span>
                      <span className="help-key">S / &#x2193;</span><span>Backward</span>
                      <span className="help-key">A / &#x2190;</span><span>Strafe left</span>
                      <span className="help-key">D / &#x2192;</span><span>Strafe right</span>
                      <span className="help-key">Q / Space</span><span>Up</span>
                      <span className="help-key">E / Shift</span><span>Down</span>
                    </div>
                    <h3>Shortcuts</h3>
                    <div className="help-grid">
                      <span className="help-key">F11</span><span>Fullscreen</span>
                      <span className="help-key">/</span><span>Focus search</span>
                      <span className="help-key">Home</span><span>Reset view</span>
                      <span className="help-key">?</span><span>Toggle help</span>
                      <span className="help-key">Esc</span><span>Close overlay</span>
                    </div>
                    <button className="help-dismiss" onClick={dismissHelp}>Got it</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <TableView
              graphData={graphData}
              onNodeClick={handleNodeClick}
            />
          )}

          {/* Modals inside graph-container so they appear in fullscreen */}
          {showStatsModal && (
            <StatsModal
              graphData={graphData}
              onClose={() => setShowStatsModal(false)}
              onNodeClick={(node) => {
                setShowStatsModal(false);
                const graphNode = graphData.nodes.find((n) => n.id === node.id);
                handleNodeClick(graphNode || node);
              }}
            />
          )}

          {detailNode && (
            <NodeDetailModal
              node={detailNode}
              graphData={graphData}
              adjacencyMap={adjacencyMap}
              onClose={() => setDetailNode(null)}
              onNodeNavigate={(navNode) => {
                setDetailNode(null);
                const target = graphData.nodes.find((n) => n.id === navNode.id);
                if (target) {
                  focusNode(target);
                  handleNodeClick(target);
                }
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
